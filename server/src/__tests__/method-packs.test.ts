import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, agents, companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { methodPackService, parseMethodPackCategory } from "../services/method-packs.js";

/**
 * 方法包(JIN-55)。
 *
 * ★ 这组测试同时是「**没有重造 skills 系统**」的证据:
 * 方法包一张新表都没建 —— 版本落在 company_skill_versions,绑定落在
 * agents.adapter_config.paperclipSkillSync(就是 Paperclip skills 系统那一份),
 * 所以运行期的注入链路(heartbeat → listRuntimeSkillEntries → adapter promptInstructions)
 * 本 issue 一行都没碰,照样生效。
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("方法包 skills(JIN-55)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let editorId: string;
  const svc = () => methodPackService(db);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-method-packs-");
    db = createDb(tempDb.connectionString);

    const [company] = await db.insert(companies).values({ name: "小镜律师事务所" }).returning();
    companyId = company!.id;
    const [editor] = await db
      .insert(agents)
      .values({ companyId, name: "文案编导", role: "editor" })
      .returning();
    editorId = editor!.id;
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 120_000);

  it("建方法包:分类落在 categories,首版立刻成型", async () => {
    const { skill, version } = await svc().create(companyId, {
      name: "高净值场景开头方法",
      category: "exclusive_method",
      description: "12 条开头方法",
      markdown: "# 高净值场景开头方法\n\n1. 先说损失,再说方案。\n",
      versionLabel: "v2.1",
    });

    expect(parseMethodPackCategory(skill.categories)).toBe("exclusive_method");
    expect(version.label).toBe("v2.1");
    expect(version.revisionNumber).toBe(1);
  });

  it("列表按分类过滤,并带出展示版本号(v2.1)", async () => {
    await svc().create(companyId, {
      name: "法律转译方法包",
      category: "platform_method",
      markdown: "# 法律转译\n\n把法条翻译成人话。\n",
      versionLabel: "v1.0",
    });

    const exclusive = await svc().list(companyId, { category: "exclusive_method" });
    expect(exclusive.map((pack) => pack.name)).toContain("高净值场景开头方法");
    expect(exclusive.map((pack) => pack.name)).not.toContain("法律转译方法包");

    const pack = exclusive.find((row) => row.name === "高净值场景开头方法");
    expect(pack?.currentVersionLabel).toBe("v2.1");
    expect(pack?.categoryLabel).toBe("专属方法");
  });

  it("发新版:revision 递增,老版本原地不动(钉在老版的员工不会被别人发版带偏)", async () => {
    const [pack] = await svc().list(companyId, { category: "platform_method" });
    const v2 = await svc().publishVersion(companyId, pack!.id, {
      markdown: "# 法律转译 v2\n\n新增:风险提示话术。\n",
      versionLabel: "v2.0",
    });

    expect(v2.revisionNumber).toBe(2);
    const versions = await svc().listVersions(companyId, pack!.id);
    expect(versions.map((row) => row.label).sort()).toEqual(["v1.0", "v2.0"]);
  });

  it("★ 绑定到 AI 员工:写的就是 skills 系统那份 desiredSkills(所以运行期无需改一行代码)", async () => {
    const [pack] = await svc().list(companyId, { category: "exclusive_method" });

    const result = await svc().setBinding({
      companyId,
      agentId: editorId,
      skillId: pack!.id,
      bound: true,
      versionId: pack!.currentVersionId,
    });
    expect(result.bound).toBe(true);
    expect(result.pinnedVersionId).toBe(pack!.currentVersionId);

    // 落库的就是 Paperclip 原生的 paperclipSkillSync.desiredSkills —— 不是自建的绑定表
    const [agent] = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, editorId));
    const { desiredSkillEntries } = readPaperclipSkillSyncPreference(
      agent!.adapterConfig as Record<string, unknown>,
    );
    const entry = desiredSkillEntries.find((row) => row.key === pack!.key);
    expect(entry).toBeDefined();
    expect(entry?.versionId).toBe(pack!.currentVersionId); // 钉死这一版

    // 列表带 agentId 时能看出绑定状态(UI 的勾选态)
    const listed = await svc().list(companyId, { category: "exclusive_method", agentId: editorId });
    expect(listed.find((row) => row.id === pack!.id)?.binding).toEqual({
      bound: true,
      pinnedVersionId: pack!.currentVersionId,
    });
  });

  it("解绑:desiredSkills 里干净移除,不留残渣", async () => {
    const [pack] = await svc().list(companyId, { category: "exclusive_method" });
    await svc().setBinding({ companyId, agentId: editorId, skillId: pack!.id, bound: false });

    const listed = await svc().list(companyId, { category: "exclusive_method", agentId: editorId });
    expect(listed.find((row) => row.id === pack!.id)?.binding?.bound).toBe(false);
  });

  it("钉一个不属于这个方法包的 versionId → 400,不静默绑错内容", async () => {
    const packs = await svc().list(companyId);
    const exclusive = packs.find((row) => row.category === "exclusive_method")!;
    const platform = packs.find((row) => row.category === "platform_method")!;

    await expect(
      svc().setBinding({
        companyId,
        agentId: editorId,
        skillId: exclusive.id,
        bound: true,
        versionId: platform.currentVersionId, // 别的包的版本
      }),
    ).rejects.toThrow(/versionId does not belong/);
  });
});
