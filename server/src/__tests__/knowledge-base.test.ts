import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, agents, collectionItems, companies, knowledgeChunks } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgeBaseService, renderKnowledgeSection } from "../services/knowledge-base.js";
import { deterministicEmbeddingProvider } from "../services/knowledge-embeddings.js";

/**
 * JIN-55 的核心验收:**按 AI 员工粒度的「可被引用」开关必须真的生效** ——
 * 关掉的员工检索不到。
 *
 * 这里用 deterministic embedding provider(不联网、不花钱、同样文本永远同样向量),
 * 于是「向量」这个变量被彻底固定住了:两个员工检索同一句话、打同样的分,
 * **唯一的差别就是开关**。这正是要测的东西。
 * (用真 GLM 反而测不干净:模型抖动会让人分不清是开关生效了还是分数飘了。)
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("知识库 RAG:按员工的引用开关(JIN-55)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  /** 选题策划师 —— 原型里对这条收藏是 ✅ */
  let plannerId: string;
  /** 账号诊断师 —— 原型里对这条收藏是 ❌ */
  let doctorId: string;
  let itemId: string;

  const svc = () => knowledgeBaseService(db, deterministicEmbeddingProvider());

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-knowledge-");
    db = createDb(tempDb.connectionString);

    const [company] = await db
      .insert(companies)
      .values({ name: "小镜律师事务所" })
      .returning();
    companyId = company!.id;

    const [planner] = await db
      .insert(agents)
      .values({ companyId, name: "选题策划师", role: "planner" })
      .returning();
    plannerId = planner!.id;

    const [doctor] = await db
      .insert(agents)
      .values({ companyId, name: "账号诊断师", role: "doctor" })
      .returning();
    doctorId = doctor!.id;

    const [item] = await db
      .insert(collectionItems)
      .values({
        companyId,
        title: "离婚财产分割案例",
        contentType: "text",
        body: "高净值客户离婚财产分割:婚前财产认定、股权分割、房产归属的实务要点与话术模板。",
        tags: ["离婚", "财产分割", "金牌素材"],
        defaultCitable: true,
      })
      .returning();
    itemId = item!.id;

    const result = await svc().indexItem(companyId, itemId);
    expect(result.status).toBe("indexed");
    expect(result.chunkCount).toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 120_000);

  it("默认可引用:两个员工都检索得到", async () => {
    const planner = await svc().retrieve({ companyId, agentId: plannerId, query: "离婚财产分割" });
    const doctor = await svc().retrieve({ companyId, agentId: doctorId, query: "离婚财产分割" });

    expect(planner.map((c) => c.itemId)).toContain(itemId);
    expect(doctor.map((c) => c.itemId)).toContain(itemId);
  });

  it("★ 关掉账号诊断师之后:诊断师检索不到,策划师照常检索得到", async () => {
    await svc().setCitationGrant({ companyId, itemId, agentId: doctorId, allowed: false });

    const doctor = await svc().retrieve({ companyId, agentId: doctorId, query: "离婚财产分割" });
    const planner = await svc().retrieve({ companyId, agentId: plannerId, query: "离婚财产分割" });

    // ★★★ 这就是验收标准:关掉的员工检索不到。
    expect(doctor.map((c) => c.itemId)).not.toContain(itemId);
    // 且开关是**按员工**的:关掉诊断师,不该波及策划师。
    expect(planner.map((c) => c.itemId)).toContain(itemId);
  });

  it("开关只影响授权,不删向量:重新打开就立刻又能检索到", async () => {
    await svc().setCitationGrant({ companyId, itemId, agentId: doctorId, allowed: false });
    const chunksWhileOff = await db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.itemId, itemId));
    // 关掉 ≠ 删数据。否则重新打开要再烧一次 embedding 的钱,而且别的员工也跟着瞎。
    expect(chunksWhileOff.length).toBeGreaterThan(0);

    // allowed=null = 删掉例外行,回落到条目默认值(true)
    await svc().setCitationGrant({ companyId, itemId, agentId: doctorId, allowed: null });
    const doctor = await svc().retrieve({ companyId, agentId: doctorId, query: "离婚财产分割" });
    expect(doctor.map((c) => c.itemId)).toContain(itemId);
  });

  it("默认不可引用的条目:只有被显式打开的员工能检索到", async () => {
    const [privateItem] = await db
      .insert(collectionItems)
      .values({
        companyId,
        title: "禁用表达清单",
        contentType: "text",
        body: "合规禁用表达:不得承诺胜诉、不得使用最高级表述、不得暗示司法关系。",
        tags: ["合规"],
        defaultCitable: false, // 默认全员不可引用
      })
      .returning();
    const privateItemId = privateItem!.id;
    await svc().indexItem(companyId, privateItemId);

    const beforePlanner = await svc().retrieve({ companyId, agentId: plannerId, query: "禁用表达 合规" });
    expect(beforePlanner.map((c) => c.itemId)).not.toContain(privateItemId);

    // 只给策划师开
    await svc().setCitationGrant({ companyId, itemId: privateItemId, agentId: plannerId, allowed: true });

    const planner = await svc().retrieve({ companyId, agentId: plannerId, query: "禁用表达 合规" });
    const doctor = await svc().retrieve({ companyId, agentId: doctorId, query: "禁用表达 合规" });
    expect(planner.map((c) => c.itemId)).toContain(privateItemId);
    expect(doctor.map((c) => c.itemId)).not.toContain(privateItemId);
  });

  it("引用矩阵:区分「默认开着」和「显式关掉」—— 原型里那一列勾选框读的就是它", async () => {
    await svc().setCitationGrant({ companyId, itemId, agentId: doctorId, allowed: false });
    const grants = await svc().listCitationGrants(companyId, itemId);

    expect(grants?.defaultCitable).toBe(true);
    const planner = grants?.agents.find((a) => a.agentId === plannerId);
    const doctor = grants?.agents.find((a) => a.agentId === doctorId);

    // 策划师:没有例外行(explicit=null),生效值来自默认值
    expect(planner?.explicit).toBeNull();
    expect(planner?.effective).toBe(true);
    // 诊断师:有一条 allowed=false 的例外行
    expect(doctor?.explicit).toBe(false);
    expect(doctor?.effective).toBe(false);

    await svc().setCitationGrant({ companyId, itemId, agentId: doctorId, allowed: null });
  });

  it("软删的收藏检索不到(deleted_at 不是摆设)", async () => {
    const [ghost] = await db
      .insert(collectionItems)
      .values({
        companyId,
        title: "过期的开头模板",
        contentType: "text",
        body: "这是一条已经被用户删掉的收藏,不该再被任何员工引用。",
        defaultCitable: true,
      })
      .returning();
    await svc().indexItem(companyId, ghost!.id);
    await db
      .update(collectionItems)
      .set({ deletedAt: new Date() })
      .where(eq(collectionItems.id, ghost!.id));

    const hits = await svc().retrieve({ companyId, agentId: plannerId, query: "过期的开头模板" });
    expect(hits.map((c) => c.itemId)).not.toContain(ghost!.id);
  });

  it("索引是幂等的:原文没变就跳过,不重复烧 embedding 的钱", async () => {
    const again = await svc().indexItem(companyId, itemId);
    expect(again.status).toBe("skipped");
    expect(again.reason).toBe("source unchanged");

    const forced = await svc().indexItem(companyId, itemId, { force: true });
    expect(forced.status).toBe("indexed");
  });

  /**
   * ★ 「开关前后,同一个员工的生成结果确实不同」的机制证据。
   *
   * 生成结果之所以会不同,是因为**喂给模型的 prompt 不同**。这里把这一段因果关系钉死:
   * 同一个员工、同一个 query,开关一关,注入 prompt 的知识库段落就整段消失。
   * (真去调一次 GLM 对比两段生成文本,只会引入模型随机性,证不出更强的东西 ——
   *  何况写这条测试的时候 GLM 账号还欠着费。)
   */
  it("★ 开关直接改变注入 prompt 的内容(生成结果不同的根因)", async () => {
    await svc().setCitationGrant({ companyId, itemId, agentId: doctorId, allowed: null });

    const onCitations = await svc().retrieve({ companyId, agentId: doctorId, query: "离婚财产分割" });
    const promptWhenOn = renderKnowledgeSection(onCitations);
    expect(promptWhenOn).toContain("离婚财产分割案例");

    await svc().setCitationGrant({ companyId, itemId, agentId: doctorId, allowed: false });

    const offCitations = await svc().retrieve({ companyId, agentId: doctorId, query: "离婚财产分割" });
    const promptWhenOff = renderKnowledgeSection(offCitations);

    // 开关关掉 → 这条收藏不在召回里 → prompt 里整段不见了 → 模型看不到它 → 生成结果必然不同
    expect(promptWhenOff).toBeNull();
    expect(promptWhenOn).not.toEqual(promptWhenOff);

    await svc().setCitationGrant({ companyId, itemId, agentId: doctorId, allowed: null });
  });
});
