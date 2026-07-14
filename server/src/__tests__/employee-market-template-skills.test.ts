import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentConfigRevisions,
  agentTemplates,
  agents,
  companies,
  companySkills,
  createDb,
} from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { employeeMarketService, type EmployeeMarketActor } from "../services/employee-market.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres employee market template tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * JIN-78 / P0-1:「存为模板」不许把方法包弄丢。
 *
 * 这条链之前是**零测试**的,于是 `readSkillPreferenceKeys()` 读了一条全仓零写入的路径
 * (`adapterConfig.paperclip.skillSync`,唯一写入方写的是顶层 `paperclipSkillSync`),
 * 恒返回 `[]`。后果:存为模板 → 模板 desiredSkills 空 → 从模板招人 → **员工零方法包**,
 * 接口 200、卡片标签直接空着、不报错。
 *
 * 所以这里测的是**完整往返**,不是单个函数的返回值:
 *   招一个带方法包的员工 → 把他存为模板 → 从这个模板再招一个 → 新员工必须还带着那些方法包。
 */
describeEmbeddedPostgres("employee market: 存为模板 → 从模板招人(方法包必须活下来)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof employeeMarketService>;
  const cleanupDirs = new Set<string>();
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  const actor: EmployeeMarketActor = { actorType: "user", actorId: "local-board" };
  const DESIRED_SKILLS = [
    { key: "legal/xhs-hook", versionId: null },
    { key: "legal/case-teardown", versionId: null },
  ];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-employee-market-template-");
    db = createDb(tempDb.connectionString);
    svc = employeeMarketService(db);

    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-employee-market-home-"));
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
  }, 120_000);

  afterEach(async () => {
    await db.delete(agentConfigRevisions);
    await db.delete(agentTemplates);
    await db.delete(agents);
    // 招聘会顺带在公司技能库里落行(resolveRequestedSkillEntries),先删它再删 companies,否则 FK 拦住
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
    await Promise.all([...cleanupDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function seedCompany() {
    return db
      .insert(companies)
      .values({
        name: `Jin ${randomUUID().slice(0, 8)}`,
        issuePrefix: `EM${randomUUID().slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  /** 读一个已招员工身上真正生效的方法包偏好(和 runtime 用的是同一个 reader) */
  async function readHiredAgentSkills(agentId: string) {
    const row = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    return readPaperclipSkillSyncPreference(
      (row.adapterConfig ?? {}) as Record<string, unknown>,
    ).desiredSkills;
  }

  it("把带方法包的员工存为模板,再从模板招人 —— 新员工的 desiredSkills 必须非空", async () => {
    const company = await seedCompany();

    // ① 先按正常流程招一个带方法包的员工(方法包写进 adapterConfig.paperclipSkillSync)
    const sourceTemplate = await svc.createTemplate(
      company.id,
      {
        name: "文案编导",
        role: "content_writer",
        instructions: "# 文案编导\n\n写口播脚本。\n",
        adapterType: "claude_local",
        adapterConfig: {},
        desiredSkills: DESIRED_SKILLS,
        visibility: "company",
      },
      actor,
    );
    const hired = await svc.hireEmployee(
      company.id,
      { source: "custom", refId: sourceTemplate.refId },
      actor,
    );

    // 前置条件:招进来的员工确实带着方法包(不然下面测的就不是「存为模板丢了」)
    expect(await readHiredAgentSkills(hired.agentId)).toEqual(
      expect.arrayContaining(["legal/xhs-hook", "legal/case-teardown"]),
    );

    // ② 「把这个员工存为模板」—— 反向抽取配方
    const savedTemplate = await svc.createTemplateFromAgent(
      company.id,
      { fromAgentId: hired.agentId, name: "文案编导(存档)" },
      actor,
    );

    // 🔴 修复前:这里是 [] —— 方法包在存为模板这一步就静默丢了
    const savedRow = await db
      .select({ desiredSkills: agentTemplates.desiredSkills })
      .from(agentTemplates)
      .where(eq(agentTemplates.id, savedTemplate.refId))
      .then((rows) => rows[0]!);
    expect(savedRow.desiredSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "legal/xhs-hook" }),
        expect.objectContaining({ key: "legal/case-teardown" }),
      ]),
    );

    // ③ 从存档模板再招一个人 —— 这才是用户真正会感知到的后果
    const rehired = await svc.hireEmployee(
      company.id,
      { source: "custom", refId: savedTemplate.refId, nameOverride: "文案编导 2 号" },
      actor,
    );

    // 🔴 核心验收:从「存为模板」建的模板招进来的员工,方法包必须非空
    const rehiredSkills = await readHiredAgentSkills(rehired.agentId);
    expect(rehiredSkills).not.toHaveLength(0);
    expect(rehiredSkills).toEqual(expect.arrayContaining(["legal/xhs-hook", "legal/case-teardown"]));

    // 卡片上的方法包标签也不能是空的(UI 里空标签就是这个 bug 的表征)
    expect(savedTemplate.methodTags.map((tag) => tag.key)).toEqual(
      expect.arrayContaining(["legal/xhs-hook", "legal/case-teardown"]),
    );
  }, 60_000);

  it("员工本来就没有方法包时,存为模板仍然是空的(不许凭空造出方法包)", async () => {
    const company = await seedCompany();
    const bare = await svc.createTemplate(
      company.id,
      {
        name: "选题策划师",
        role: "topic_planner",
        instructions: "# 选题策划师\n",
        adapterType: "claude_local",
        adapterConfig: {},
        desiredSkills: [],
        visibility: "company",
      },
      actor,
    );
    const hired = await svc.hireEmployee(company.id, { source: "custom", refId: bare.refId }, actor);

    const saved = await svc.createTemplateFromAgent(
      company.id,
      { fromAgentId: hired.agentId, name: "选题策划师(存档)" },
      actor,
    );

    const savedRow = await db
      .select({ desiredSkills: agentTemplates.desiredSkills })
      .from(agentTemplates)
      .where(eq(agentTemplates.id, saved.refId))
      .then((rows) => rows[0]!);
    expect(savedRow.desiredSkills).toEqual([]);
    expect(await readHiredAgentSkills(hired.agentId)).toEqual([]);
  }, 60_000);
});
