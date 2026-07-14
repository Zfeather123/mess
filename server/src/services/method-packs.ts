import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type Db, agents, companySkills, companySkillVersions } from "@paperclipai/db";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { parseFrontmatterMarkdown, stringifyFrontmatter } from "@paperclipai/shared";
import {
  METHOD_PACK_CATEGORIES,
  METHOD_PACK_CATEGORY_LABELS,
  type MethodPackCategory,
} from "@paperclipai/shared/validators/knowledge";
import { companySkillService } from "./company-skills.js";
import { badRequest, notFound } from "../errors.js";

/**
 * 方法包(JIN-55)。
 *
 * ★ **零新表**。方法包 = company_skills 里带方法包分类的 skill。
 *
 * Paperclip 的 skills 系统已经有本 issue 需要的全部东西:
 *   - 版本化   → company_skill_versions.revision_number + label(「v2.1」就是 label)
 *   - 绑定员工 → agents.adapter_config.paperclipSkillSync.desiredSkills[{key, versionId}]
 *               versionId 传了 = 钉死这一版;不传 = 跟随最新版
 *   - 运行期注入 → heartbeat 的 listRuntimeSkillEntries → adapter 的 promptInstructions
 *   - 还带评论、测试用例、fork
 *
 * 新建一张 method_packs 表就要把上面每一样重写一遍,而且立刻产生第二份真相
 * (员工绑的到底是 skill 还是 method_pack?运行期注入哪一份?)。所以这里只加一层
 * 很薄的 facade:分类词表 + 「建包/发版/绑人」三件事拼成一次调用。
 *
 * 分类落在 company_skills.categories(text[])上,前缀 `method:` 命名空间化 ——
 * 避免和 Paperclip 自带的技能分类(如 "engineering")撞车。
 */

const CATEGORY_PREFIX = "method:";

/**
 * 方法包的 slug。
 *
 * 上游的 slug 规范是 ASCII-only(normalizeAgentUrlKey),而方法包的名字几乎全是中文
 * (「高净值场景开头方法」「法律转译方法包」)—— 直接交给上游会被清成空串,
 * 于是所有方法包都回落到同一个字面量 slug,第二个开始必然 409。
 *
 * 所以:能 ASCII 化就 ASCII 化(英文名保持可读);清完是空的,就用名字的 sha256 前 8 位兜底。
 * 哈希是**按名字确定**的 —— 同名必然同 slug,所以「重名」照旧会撞 409(这是对的,重名本该拒),
 * 而不同名的中文方法包永远不会互相抢 slug。
 */
export function methodPackSlug(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii.length > 0) return ascii.slice(0, 60);
  const digest = createHash("sha256").update(name.trim(), "utf8").digest("hex").slice(0, 8);
  return `method-${digest}`;
}

export function methodPackCategoryTag(category: MethodPackCategory): string {
  return `${CATEGORY_PREFIX}${category}`;
}

/**
 * ★ 把分类写进 SKILL.md 的 frontmatter —— **不能只写 DB**。
 *
 * 因为 skills 系统把 SKILL.md 当作分类的**唯一真相**:updateFile / ensureSkillInventoryCurrent
 * 每次都会 `categories = readSkillStoreMetadata(frontmatter, metadata)` 从磁盘重新推导,
 * 然后覆盖 DB 那一列。只写 DB 的话,方法包**发一次新版分类就被清空**,
 * 直接从方法包列表里消失(这个 bug 是被 method-packs.test.ts 的「发新版」用例逮到的)。
 *
 * 所以正解是顺着上游的真相走:分类落在 frontmatter,DB 那一列是它的投影。
 */
export function withMethodPackFrontmatter(
  markdown: string,
  input: { name: string; category: MethodPackCategory; description?: string | null },
): string {
  const parsed = parseFrontmatterMarkdown(markdown);
  const existing = parsed.frontmatter ?? {};
  const categories = normalizeCategories([
    ...(Array.isArray(existing.categories) ? (existing.categories as unknown[]) : []),
    methodPackCategoryTag(input.category),
  ]);
  const frontmatter: Record<string, unknown> = {
    ...existing,
    name: typeof existing.name === "string" && existing.name.trim() ? existing.name : input.name,
    categories,
  };
  const description = input.description?.trim();
  if (description && !existing.description) frontmatter.description = description;

  return `---\n${stringifyFrontmatter(frontmatter)}\n---\n\n${parsed.body.trim()}\n`;
}

/** 同一个方法包只保留一个 method: 分类;其它分类原样留着(用户可能自己打了别的标)。 */
function normalizeCategories(values: unknown[]): string[] {
  const out: string[] = [];
  let methodTagSeen = false;
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const tag = value.trim();
    if (tag.startsWith(CATEGORY_PREFIX)) {
      if (methodTagSeen) continue;
      methodTagSeen = true;
    }
    if (!out.includes(tag)) out.push(tag);
  }
  // method: 分类排前面,列表读的就是第一个命中的
  return out.sort((a, b) => Number(b.startsWith(CATEGORY_PREFIX)) - Number(a.startsWith(CATEGORY_PREFIX)));
}

export function parseMethodPackCategory(categories: string[]): MethodPackCategory | null {
  for (const raw of categories) {
    if (!raw.startsWith(CATEGORY_PREFIX)) continue;
    const value = raw.slice(CATEGORY_PREFIX.length) as MethodPackCategory;
    if (METHOD_PACK_CATEGORIES.includes(value)) return value;
  }
  return null;
}

export interface MethodPackSummary {
  id: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  category: MethodPackCategory;
  categoryLabel: string;
  currentVersionId: string | null;
  /** 展示版本号:优先用 label(「v2.1」),没有就退回 r{revisionNumber}。 */
  currentVersionLabel: string | null;
  revisionNumber: number | null;
  /** 只有查询带了 agentId 才有值。 */
  binding?: {
    bound: boolean;
    /** 钉死的版本;null = 跟随最新版。 */
    pinnedVersionId: string | null;
  };
}

export function methodPackService(db: Db) {
  const skills = companySkillService(db);

  async function currentVersionOf(skillId: string) {
    return db
      .select({
        id: companySkillVersions.id,
        label: companySkillVersions.label,
        revisionNumber: companySkillVersions.revisionNumber,
      })
      .from(companySkillVersions)
      .where(eq(companySkillVersions.companySkillId, skillId))
      .orderBy(companySkillVersions.revisionNumber)
      .then((rows) => rows[rows.length - 1] ?? null);
  }

  async function toSummary(row: {
    id: string;
    key: string;
    slug: string;
    name: string;
    description: string | null;
    categories: string[];
    currentVersionId: string | null;
  }): Promise<MethodPackSummary | null> {
    const category = parseMethodPackCategory(row.categories ?? []);
    if (!category) return null;
    const version = await currentVersionOf(row.id);
    return {
      id: row.id,
      key: row.key,
      slug: row.slug,
      name: row.name,
      description: row.description,
      category,
      categoryLabel: METHOD_PACK_CATEGORY_LABELS[category],
      currentVersionId: row.currentVersionId ?? version?.id ?? null,
      currentVersionLabel: version?.label ?? (version ? `r${version.revisionNumber}` : null),
      revisionNumber: version?.revisionNumber ?? null,
    };
  }

  /** 列方法包。带 agentId 就顺便标出「这个员工绑没绑、钉在哪一版」。 */
  async function list(
    companyId: string,
    filters: { category?: MethodPackCategory; agentId?: string } = {},
  ): Promise<MethodPackSummary[]> {
    const rows = await db
      .select({
        id: companySkills.id,
        key: companySkills.key,
        slug: companySkills.slug,
        name: companySkills.name,
        description: companySkills.description,
        categories: companySkills.categories,
        currentVersionId: companySkills.currentVersionId,
      })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));

    const summaries: MethodPackSummary[] = [];
    for (const row of rows) {
      const summary = await toSummary(row);
      if (!summary) continue;
      if (filters.category && summary.category !== filters.category) continue;
      summaries.push(summary);
    }

    if (filters.agentId) {
      const agent = await db
        .select({ adapterConfig: agents.adapterConfig })
        .from(agents)
        .where(and(eq(agents.id, filters.agentId), eq(agents.companyId, companyId)))
        .then((agentRows) => agentRows[0] ?? null);
      if (!agent) throw notFound("Agent not found");
      const { desiredSkillEntries } = readPaperclipSkillSyncPreference(
        (agent.adapterConfig ?? {}) as Record<string, unknown>,
      );
      const byKey = new Map(desiredSkillEntries.map((entry) => [entry.key, entry]));
      for (const summary of summaries) {
        const entry = byKey.get(summary.key);
        summary.binding = { bound: Boolean(entry), pinnedVersionId: entry?.versionId ?? null };
      }
    }
    return summaries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 建方法包 = 建一个 local skill,然后把它自动生成的首版打上版本标签(如「v2.1」)。
   *
   * ⚠️ 两个坑,都是被测试逼出来的:
   *
   * 1) createLocalSkill **自己已经发过一版**了(label="Initial version", revision=1)。
   *    这里再调一次 createVersion,方法包的「第一版」就成了 revision 2 —— 凭空多一版。
   *    所以这里只**改写首版的 label**,不新建版本。
   *
   * 2) skill 的 slug 走 normalizeAgentUrlKey,它会把非 ASCII 全部丢掉 ——
   *    「高净值场景开头方法」normalize 完是空,于是 createLocalSkill 回落到字面量 "skill"。
   *    结果:**所有中文名的方法包都抢同一个 slug**,第二个就 409。
   *    产品里方法包名字基本全是中文,等于建完第一个就再也建不了第二个。
   *    → 这里显式给 slug:能 ASCII 化就 ASCII 化,不能就用名字的哈希兜底(稳定、唯一)。
   */
  async function create(
    companyId: string,
    input: {
      name: string;
      category: MethodPackCategory;
      description?: string | null;
      markdown: string;
      versionLabel?: string | null;
    },
    actor: { type: "user"; userId: string } | { type: "agent"; agentId: string } | null = null,
  ) {
    const skill = await skills.createLocalSkill(
      companyId,
      {
        name: input.name,
        slug: methodPackSlug(input.name),
        description: input.description ?? null,
        // 分类必须同时进 frontmatter(磁盘真相)和 categories(DB 投影),否则发版即丢分类。
        markdown: withMethodPackFrontmatter(input.markdown, {
          name: input.name,
          category: input.category,
          description: input.description,
        }),
        categories: [methodPackCategoryTag(input.category)],
      },
      actor,
    );

    // createLocalSkill 已经建好 revision 1;这里只是把它的 label 换成产品要的版本号。
    const version = await relabelCurrentVersion(skill.id, input.versionLabel);
    return { skill, version };
  }

  /**
   * createLocalSkill / updateFile 都会**自己顺手发一版**(无 label 的快照)。
   * 所以这里绝不能再调 createVersion —— 那会凭空多出一版,revision 直接跳到 3。
   * 正确做法:把它们刚发的那一版重新打上标签。
   */
  async function relabelCurrentVersion(skillId: string, versionLabel?: string | null) {
    const label = versionLabel?.trim();
    const current = await currentVersionOf(skillId);
    if (!current) throw notFound("Method pack version not found");
    if (!label) return current;
    await db
      .update(companySkillVersions)
      .set({ label })
      .where(eq(companySkillVersions.id, current.id));
    return { ...current, label };
  }

  /**
   * 发新版:改正文 → 快照成一个新 revision。
   * 老版本一行都不动 —— 已经钉在老版上的员工,行为不会因为别人发了新版就漂移。
   */
  async function publishVersion(
    companyId: string,
    skillId: string,
    input: { markdown: string; versionLabel?: string | null },
    actor: { type: "user"; userId: string } | { type: "agent"; agentId: string } | null = null,
  ) {
    const pack = await skills.getById(companyId, skillId);
    if (!pack) throw notFound("Method pack not found");
    const category = parseMethodPackCategory(pack.categories ?? []);
    if (!category) throw badRequest("This skill is not a method pack");

    // 新正文必须重新带上分类的 frontmatter,否则 updateFile 会按「没有分类」把 categories 清空,
    // 这个方法包就从方法包列表里消失了(而它其实还在,只是不再被认成方法包)。
    await skills.updateFile(
      companyId,
      skillId,
      "SKILL.md",
      withMethodPackFrontmatter(input.markdown, {
        name: pack.name,
        category,
        description: pack.description,
      }),
      actor,
    );
    // updateFile 内部已经发了一版快照 —— 只需给它打上标签,不能再 createVersion。
    return relabelCurrentVersion(skillId, input.versionLabel);
  }

  /**
   * 绑定/解绑方法包到 AI 员工。
   *
   * 写的就是 skills 系统那份 desiredSkills —— 所以 heartbeat 的 listRuntimeSkillEntries
   * 会原样把它注入到 agent 的 prompt 里,本 issue 不需要碰运行期任何一行代码。
   */
  async function setBinding(input: {
    companyId: string;
    agentId: string;
    skillId: string;
    bound: boolean;
    versionId?: string | null;
  }) {
    const pack = await skills.getById(input.companyId, input.skillId);
    if (!pack) throw notFound("Method pack not found");
    if (!parseMethodPackCategory(pack.categories ?? [])) {
      throw badRequest("This skill is not a method pack");
    }

    const agent = await db
      .select({ id: agents.id, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");

    if (input.versionId) {
      const version = await db
        .select({ id: companySkillVersions.id })
        .from(companySkillVersions)
        .where(
          and(
            eq(companySkillVersions.id, input.versionId),
            eq(companySkillVersions.companySkillId, input.skillId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      // 钉一个不属于这个方法包的 versionId = 静默绑错内容。宁可 400。
      if (!version) throw badRequest("versionId does not belong to this method pack");
    }

    const config = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const { desiredSkillEntries } = readPaperclipSkillSyncPreference(config);
    const withoutPack = desiredSkillEntries.filter((entry) => entry.key !== pack.key);
    const next = input.bound
      ? [...withoutPack, { key: pack.key, versionId: input.versionId ?? null }]
      : withoutPack;

    const nextConfig = writePaperclipSkillSyncPreference(config, next);
    await db
      .update(agents)
      .set({ adapterConfig: nextConfig, updatedAt: new Date() })
      .where(eq(agents.id, input.agentId));

    return {
      agentId: input.agentId,
      skillId: input.skillId,
      key: pack.key,
      bound: input.bound,
      pinnedVersionId: input.bound ? input.versionId ?? null : null,
    };
  }

  return { list, create, publishVersion, setBinding, listVersions: skills.listVersions };
}

export type MethodPackService = ReturnType<typeof methodPackService>;
