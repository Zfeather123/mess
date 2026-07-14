import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  type Db,
  agents,
  collectionCitationGrants,
  collectionItemIndexState,
  collectionItems,
  knowledgeChunks,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  type EmbeddingProvider,
  chunkText,
  dotProduct,
  resolveEmbeddingProvider,
  sha256,
} from "./knowledge-embeddings.js";

/**
 * 知识库(RAG)检索(JIN-55)。
 *
 * ★ 本文件的灵魂是一句 SQL:
 *
 *     COALESCE(grant.allowed, item.default_citable) = TRUE
 *
 * 「同一条收藏,选题策划师能引用、账号诊断师不能引用」—— 这个开关**在 SQL 里就把行滤掉了**,
 * 不是查回来再在应用层 filter。差别在于:后者只要有人多写一条 code path(比如加个
 * 「管理员预览」接口、加个批量导出),就会绕过 filter 把关掉的条目泄出去。
 * 把它焊在取数那一层,新增的调用方想泄漏都泄漏不了。
 *
 * 授权解析式(和 0148 collection_citation_grants 的注释一致):
 *   allowed = COALESCE(例外行.allowed, 条目.default_citable)
 * 即:默认值 + 例外行。授权表里只存「和默认不同」的那几行,所以它始终很小。
 */

/** 一次检索最多扫多少 chunk。超过就截断 —— 并且**大声说出来**,不静默截断。 */
const MAX_CANDIDATE_CHUNKS = 5_000;
const DEFAULT_TOP_K = 5;
/** 低于这个分数的召回直接丢掉:宁可不给,也不要塞一段不相干的东西进 prompt 误导模型。 */
const MIN_SCORE = 0.05;

export interface KnowledgeCitation {
  itemId: string;
  chunkId: string;
  title: string;
  snippet: string;
  score: number;
  tags: string[];
}

export interface IndexItemResult {
  itemId: string;
  status: "indexed" | "failed" | "skipped";
  chunkCount: number;
  embeddingModel: string | null;
  reason?: string;
}

/**
 * 一条收藏条目的「可索引原文」。
 * 标题也拼进去:很多收藏正文很短(「禁用表达清单」),标题才是最强的检索信号。
 */
function buildSourceText(item: {
  title: string;
  body: string | null;
  tags: string[] | null;
}): string {
  const parts = [item.title, ...(item.tags ?? []), item.body ?? ""];
  return parts.filter((part) => part && part.trim().length > 0).join("\n").trim();
}

export function knowledgeBaseService(db: Db, provider: EmbeddingProvider = resolveEmbeddingProvider()) {
  /**
   * 索引一条收藏:切片 → embedding → 落库。
   *
   * 幂等:原文哈希没变就直接跳过(status=skipped),不重复烧 embedding 的钱。
   * force=true 才强制重算(换 embedding 模型时用)。
   */
  async function indexItem(
    companyId: string,
    itemId: string,
    options: { force?: boolean } = {},
  ): Promise<IndexItemResult> {
    const item = await db
      .select({
        id: collectionItems.id,
        companyId: collectionItems.companyId,
        title: collectionItems.title,
        body: collectionItems.body,
        tags: collectionItems.tags,
        deletedAt: collectionItems.deletedAt,
      })
      .from(collectionItems)
      .where(and(eq(collectionItems.id, itemId), eq(collectionItems.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!item || item.deletedAt) {
      return { itemId, status: "skipped", chunkCount: 0, embeddingModel: null, reason: "item not found or deleted" };
    }

    const sourceText = buildSourceText(item);
    if (sourceText.length === 0) {
      return { itemId, status: "skipped", chunkCount: 0, embeddingModel: null, reason: "empty source text" };
    }

    const sourceHash = sha256(`${provider.model}::${sourceText}`);
    const existing = await db
      .select({ sourceHash: collectionItemIndexState.sourceHash, status: collectionItemIndexState.status })
      .from(collectionItemIndexState)
      .where(eq(collectionItemIndexState.itemId, itemId))
      .then((rows) => rows[0] ?? null);

    if (!options.force && existing?.sourceHash === sourceHash && existing.status === "indexed") {
      const [row] = await db
        .select({ chunkCount: collectionItemIndexState.chunkCount })
        .from(collectionItemIndexState)
        .where(eq(collectionItemIndexState.itemId, itemId));
      return {
        itemId,
        status: "skipped",
        chunkCount: row?.chunkCount ?? 0,
        embeddingModel: provider.model,
        reason: "source unchanged",
      };
    }

    const chunks = chunkText(sourceText);
    let vectors: number[][];
    try {
      vectors = await provider.embed(chunks);
    } catch (error) {
      // provider 挂了(欠费 / 限流 / 超时):把失败原因写进库,不吞。
      // 注意原文 chunk 不删 —— 一次 429 不该让用户重新上传资料。
      const reason = error instanceof Error ? error.message : String(error);
      await upsertIndexState({
        itemId,
        companyId,
        sourceHash,
        status: "failed",
        chunkCount: 0,
        error: reason,
        indexedAt: null,
      });
      logger.error({ err: error, itemId, companyId }, "knowledge indexing failed: embedding provider error");
      return { itemId, status: "failed", chunkCount: 0, embeddingModel: provider.model, reason };
    }

    await db.transaction(async (tx) => {
      // 全量重写这条 item 的 chunk:切片数量可能变少,残留的旧 chunk 会变成永远检索得到的幽灵。
      await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.itemId, itemId));
      if (chunks.length > 0) {
        await tx.insert(knowledgeChunks).values(
          chunks.map((content, chunkIndex) => ({
            companyId,
            itemId,
            chunkIndex,
            content,
            contentHash: sha256(content),
            embedding: vectors[chunkIndex] ?? null,
            embeddingModel: provider.model,
            embeddingDims: provider.dims,
            charCount: content.length,
          })),
        );
      }
    });

    await upsertIndexState({
      itemId,
      companyId,
      sourceHash,
      status: "indexed",
      chunkCount: chunks.length,
      error: null,
      indexedAt: new Date(),
    });

    return { itemId, status: "indexed", chunkCount: chunks.length, embeddingModel: provider.model };
  }

  async function upsertIndexState(input: {
    itemId: string;
    companyId: string;
    sourceHash: string;
    status: "pending" | "indexed" | "failed";
    chunkCount: number;
    error: string | null;
    indexedAt: Date | null;
  }): Promise<void> {
    await db
      .insert(collectionItemIndexState)
      .values({
        itemId: input.itemId,
        companyId: input.companyId,
        sourceHash: input.sourceHash,
        status: input.status,
        chunkCount: input.chunkCount,
        embeddingModel: provider.model,
        embeddingDims: provider.dims,
        error: input.error,
        indexedAt: input.indexedAt,
      })
      .onConflictDoUpdate({
        target: collectionItemIndexState.itemId,
        set: {
          sourceHash: input.sourceHash,
          status: input.status,
          chunkCount: input.chunkCount,
          embeddingModel: provider.model,
          embeddingDims: provider.dims,
          error: input.error,
          indexedAt: input.indexedAt,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * ★ 检索。引用开关在 WHERE 里生效 —— 关掉的员工**取不到这一行**。
   *
   * 排序在应用层做(点积),不在 SQL 里:没有 pgvector(embedded postgres 装不了),
   * 而候选集已经被 company + 未删除 + 有向量 + **可引用** 四道条件砍过,量级很小。
   */
  async function retrieve(input: {
    companyId: string;
    agentId: string;
    query: string;
    topK?: number;
    douyinAccountId?: string | null;
  }): Promise<KnowledgeCitation[]> {
    const topK = input.topK ?? DEFAULT_TOP_K;
    const trimmedQuery = input.query.trim();
    if (trimmedQuery.length === 0) return [];

    const conditions = [
      eq(knowledgeChunks.companyId, input.companyId),
      isNull(collectionItems.deletedAt),
      sql`${knowledgeChunks.embedding} is not null`,
      // ★★★ 这就是验收标准里的那个开关。默认值 + 例外行。
      sql`coalesce(${collectionCitationGrants.allowed}, ${collectionItems.defaultCitable}) = true`,
    ];
    if (input.douyinAccountId) {
      conditions.push(eq(collectionItems.douyinAccountId, input.douyinAccountId));
    }

    const candidates = await db
      .select({
        chunkId: knowledgeChunks.id,
        itemId: knowledgeChunks.itemId,
        content: knowledgeChunks.content,
        embedding: knowledgeChunks.embedding,
        title: collectionItems.title,
        tags: collectionItems.tags,
      })
      .from(knowledgeChunks)
      .innerJoin(collectionItems, eq(collectionItems.id, knowledgeChunks.itemId))
      .leftJoin(
        collectionCitationGrants,
        and(
          eq(collectionCitationGrants.itemId, knowledgeChunks.itemId),
          eq(collectionCitationGrants.agentId, input.agentId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(knowledgeChunks.updatedAt))
      .limit(MAX_CANDIDATE_CHUNKS);

    if (candidates.length === MAX_CANDIDATE_CHUNKS) {
      // 不静默截断:候选集打满意味着这家公司的知识库已经超出暴力余弦的舒适区,该上向量索引了。
      logger.warn(
        { companyId: input.companyId, agentId: input.agentId, cap: MAX_CANDIDATE_CHUNKS },
        "knowledge retrieval hit the candidate cap — recall may be truncated; time to move to a vector index",
      );
    }
    if (candidates.length === 0) return [];

    const [queryVector] = await provider.embed([trimmedQuery]);
    if (!queryVector) return [];

    const scored = candidates
      .map((candidate) => ({
        candidate,
        score: dotProduct(queryVector, candidate.embedding ?? []),
      }))
      .filter((row) => row.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score);

    // 一条 item 只出一个最佳 chunk:否则一篇长文档能把 top-K 全占满,其它资料一条都进不去。
    const seenItems = new Set<string>();
    const citations: KnowledgeCitation[] = [];
    for (const row of scored) {
      if (seenItems.has(row.candidate.itemId)) continue;
      seenItems.add(row.candidate.itemId);
      citations.push({
        itemId: row.candidate.itemId,
        chunkId: row.candidate.chunkId,
        title: row.candidate.title,
        snippet: row.candidate.content.slice(0, 500),
        score: Number(row.score.toFixed(4)),
        tags: row.candidate.tags ?? [],
      });
      if (citations.length >= topK) break;
    }
    return citations;
  }

  /**
   * 某个员工到底能引用哪些条目(id 集合)。
   * 和 retrieve 用的是同一个解析式 —— 单一真相,不会出现「检索说能、UI 说不能」。
   */
  async function listCitableItemIds(companyId: string, agentId: string): Promise<string[]> {
    const rows = await db
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .leftJoin(
        collectionCitationGrants,
        and(
          eq(collectionCitationGrants.itemId, collectionItems.id),
          eq(collectionCitationGrants.agentId, agentId),
        ),
      )
      .where(
        and(
          eq(collectionItems.companyId, companyId),
          isNull(collectionItems.deletedAt),
          sql`coalesce(${collectionCitationGrants.allowed}, ${collectionItems.defaultCitable}) = true`,
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * 一条收藏 × 全公司 AI 员工的**生效**引用矩阵 —— 原型里那一列勾选框就读这个。
   * 返回 effective(生效值)和 explicit(有没有例外行),UI 才能区分
   * 「默认开着」和「显式打开」——后者用户关掉时要删例外行,前者要新建一条 allowed=false。
   */
  async function listCitationGrants(companyId: string, itemId: string) {
    const item = await db
      .select({ defaultCitable: collectionItems.defaultCitable })
      .from(collectionItems)
      .where(and(eq(collectionItems.id, itemId), eq(collectionItems.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!item) return null;

    const rows = await db
      .select({
        agentId: agents.id,
        agentName: agents.name,
        agentRole: agents.role,
        explicit: collectionCitationGrants.allowed,
      })
      .from(agents)
      .leftJoin(
        collectionCitationGrants,
        and(
          eq(collectionCitationGrants.agentId, agents.id),
          eq(collectionCitationGrants.itemId, itemId),
        ),
      )
      .where(eq(agents.companyId, companyId));

    return {
      itemId,
      defaultCitable: item.defaultCitable,
      agents: rows.map((row) => ({
        agentId: row.agentId,
        agentName: row.agentName,
        agentRole: row.agentRole,
        explicit: row.explicit,
        effective: row.explicit ?? item.defaultCitable,
      })),
    };
  }

  /**
   * 拨开关。allowed=null = 删掉例外行,回落到条目默认值。
   *
   * 注意这里**不重新索引**:开关是读侧的授权,和向量无关。
   * 把开关做成「关掉就删向量」会有两个后果:再打开要重新烧钱,而且别的员工也跟着检索不到了。
   */
  async function setCitationGrant(input: {
    companyId: string;
    itemId: string;
    agentId: string;
    allowed: boolean | null;
    grantedByUserId?: string | null;
  }): Promise<{ effective: boolean }> {
    const item = await db
      .select({ defaultCitable: collectionItems.defaultCitable })
      .from(collectionItems)
      .where(and(eq(collectionItems.id, input.itemId), eq(collectionItems.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!item) throw new Error("collection item not found");

    if (input.allowed === null) {
      await db
        .delete(collectionCitationGrants)
        .where(
          and(
            eq(collectionCitationGrants.itemId, input.itemId),
            eq(collectionCitationGrants.agentId, input.agentId),
          ),
        );
      return { effective: item.defaultCitable };
    }

    await db
      .insert(collectionCitationGrants)
      .values({
        companyId: input.companyId,
        itemId: input.itemId,
        agentId: input.agentId,
        allowed: input.allowed,
        grantedByUserId: input.grantedByUserId ?? null,
      })
      .onConflictDoUpdate({
        target: [collectionCitationGrants.itemId, collectionCitationGrants.agentId],
        set: { allowed: input.allowed, updatedAt: new Date() },
      });
    return { effective: input.allowed };
  }

  /** 把公司里没索引 / 已过期的条目批量补上。给后台任务用。 */
  async function reindexCompany(companyId: string, options: { force?: boolean } = {}) {
    const items = await db
      .select({ id: collectionItems.id })
      .from(collectionItems)
      .where(and(eq(collectionItems.companyId, companyId), isNull(collectionItems.deletedAt)));

    const results: IndexItemResult[] = [];
    for (const item of items) {
      results.push(await indexItem(companyId, item.id, options));
    }
    return results;
  }

  return {
    provider,
    indexItem,
    reindexCompany,
    retrieve,
    listCitableItemIds,
    listCitationGrants,
    setCitationGrant,
  };
}

export type KnowledgeBaseService = ReturnType<typeof knowledgeBaseService>;

/**
 * 注入文案。和 renderFeedbackNotesSection 一个路数:进 task markdown,不进 instructionsPrefix
 * (per-run 上下文放进可缓存系统前缀 = 击穿 prompt caching,这是硬约束)。
 *
 * 「优先引用已开启的收藏项」是产品原文,所以这里明确写成 prefer,而不是硬性要求模型必须引用 ——
 * 检索召回的东西不一定真的相关,强制引用只会逼模型硬凑。
 */
export function renderKnowledgeSection(citations: KnowledgeCitation[]): string | null {
  if (citations.length === 0) return null;
  const lines = [
    "Knowledge base (你的收藏库中,**允许你引用**的条目里检索到的最相关内容 —— 生成内容时优先引用它们):",
  ];
  citations.forEach((citation, index) => {
    lines.push(
      "",
      `${index + 1}. ${citation.title}${citation.tags.length > 0 ? ` [${citation.tags.join(", ")}]` : ""}`,
      citation.snippet,
    );
  });
  lines.push(
    "",
    "这些条目是按「该员工可引用」的授权过滤后检索出来的。没检索到的条目要么不相关,要么用户没授权你引用 —— 不要凭记忆脑补收藏库里的内容。",
  );
  return lines.join("\n");
}

/**
 * 一轮 run 的注入取数:用 issue 的标题+描述当 query,取 top-K 可引用条目。
 * 失败不拖垮 run —— 知识库是增强项,不是必需项(同 loadFeedbackNotesForPrompt)。
 */
export async function loadKnowledgeForPrompt(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    query: string;
    limit?: number;
    douyinAccountId?: string | null;
  },
): Promise<KnowledgeCitation[]> {
  const query = input.query.trim();
  if (query.length === 0) return [];
  const svc = knowledgeBaseService(db);
  return svc.retrieve({
    companyId: input.companyId,
    agentId: input.agentId,
    query,
    topK: input.limit ?? DEFAULT_TOP_K,
    douyinAccountId: input.douyinAccountId ?? null,
  });
}
