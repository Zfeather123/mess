import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentFeedbackNotes,
  agents,
  companies,
  createDb,
  douyinAccounts,
  issues,
  squads,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  agentFeedbackNoteService,
  buildInjectableNotesQuery,
  loadFeedbackNotesForPrompt,
  renderFeedbackNotesSection,
  resolveFeedbackNoteInjectLimit,
  resolveFeedbackNoteInjectionStates,
} from "../services/agent-feedback-notes.js";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("feedback note prompt rendering", () => {
  it("keeps corrections and reminders as separate blocks — not one mush", () => {
    const section = renderFeedbackNotesSection([
      { id: "1", kind: "correction", content: "标题太标题党了,别再用「震惊」体" },
      { id: "2", kind: "reminder", content: "出镜话术先过一遍合规" },
      { id: "3", kind: "correction", content: "法条引用要带条号" },
      { id: "4", kind: "preference", content: "结尾固定加一句「具体case具体分析」" },
    ]);

    expect(section).toContain("Recently corrected (do not repeat these mistakes):");
    expect(section).toContain("Watch out for next time:");
    expect(section).toContain("Standing preferences:");
    // correction 和 reminder 各自成块,不混在一起
    const correctionBlock = section!.split("Watch out for next time:")[0]!;
    expect(correctionBlock).toContain("别再用「震惊」体");
    expect(correctionBlock).toContain("法条引用要带条号");
    expect(correctionBlock).not.toContain("出镜话术先过一遍合规");
  });

  it("renders nothing when the agent has no notes", () => {
    expect(renderFeedbackNotesSection([])).toBeNull();
  });

  it("injects the notes before the closing assignment line, inside the cacheable-safe task block", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: { id: "i1", identifier: "JIN-9", title: "写一条普法短视频脚本" },
      feedbackNotes: [{ id: "1", kind: "correction", content: "别再用「震惊」体" }],
    })!;

    const notesAt = markdown.indexOf("Your feedback notes");
    const closingAt = markdown.indexOf("Use this task context as the current assignment.");
    expect(notesAt).toBeGreaterThan(-1);
    expect(notesAt).toBeLessThan(closingAt);
  });

  it("the inject limit is configurable and defaults to 10", () => {
    expect(resolveFeedbackNoteInjectLimit({})).toBe(10);
    expect(resolveFeedbackNoteInjectLimit({ PAPERCLIP_AGENT_FEEDBACK_NOTE_INJECT_LIMIT: "3" })).toBe(3);
    // 0 = 关闭注入
    expect(resolveFeedbackNoteInjectLimit({ PAPERCLIP_AGENT_FEEDBACK_NOTE_INJECT_LIMIT: "0" })).toBe(0);
    // 上限兜底,别把 5000 条塞进 prompt
    expect(resolveFeedbackNoteInjectLimit({ PAPERCLIP_AGENT_FEEDBACK_NOTE_INJECT_LIMIT: "9999" })).toBe(50);
    expect(resolveFeedbackNoteInjectLimit({ PAPERCLIP_AGENT_FEEDBACK_NOTE_INJECT_LIMIT: "junk" })).toBe(10);
  });
});

describe("feedback note injection state (看得见 ≠ 会生效)", () => {
  const NOW = new Date("2026-07-15T00:00:00Z");

  function candidate(overrides: {
    id: string;
    weight?: number;
    status?: "active" | "archived" | "superseded";
    createdAt?: string;
    expiresAt?: string | null;
    douyinAccountId?: string | null;
    projectId?: string | null;
  }) {
    return {
      id: overrides.id,
      status: overrides.status ?? "active",
      weight: overrides.weight ?? 100,
      createdAt: new Date(overrides.createdAt ?? "2026-01-01T00:00:00Z"),
      expiresAt: overrides.expiresAt === undefined ? null : overrides.expiresAt === null ? null : new Date(overrides.expiresAt),
      douyinAccountId: overrides.douyinAccountId ?? null,
      projectId: overrides.projectId ?? null,
    };
  }

  it("排在注入 limit 之外的笔记是 over_limit —— 主页不能把它画成会生效的", () => {
    // 12 条笔记,limit=10:第 11、12 条永远进不了 prompt,尽管主页 100 条都列出来。
    const notes = Array.from({ length: 12 }, (_, index) =>
      candidate({ id: `n${index + 1}`, weight: 1000 - index }),
    );

    const states = resolveFeedbackNoteInjectionStates(notes, 10, NOW);

    expect(states.get("n10")).toBe("injected");
    expect(states.get("n11")).toBe("over_limit");
    expect(states.get("n12")).toBe("over_limit");
    expect([...states.values()].filter((state) => state === "injected")).toHaveLength(10);
  });

  it("过期笔记是 expired —— 没有任何 job 会把它扫成 archived,它会永远挂在主页上", () => {
    const states = resolveFeedbackNoteInjectionStates(
      [
        candidate({ id: "expired", expiresAt: "2026-07-14T23:59:00Z" }),
        candidate({ id: "live", expiresAt: "2026-07-16T00:00:00Z" }),
        candidate({ id: "forever", expiresAt: null }),
      ],
      10,
      NOW,
    );

    expect(states.get("expired")).toBe("expired");
    expect(states.get("live")).toBe("injected");
    expect(states.get("forever")).toBe("injected");
  });

  it("过期的笔记不占注入名额 —— 它挤不掉后面真正会生效的那条", () => {
    const states = resolveFeedbackNoteInjectionStates(
      [
        candidate({ id: "expired-high", weight: 900, expiresAt: "2026-07-14T00:00:00Z" }),
        candidate({ id: "live-low", weight: 100 }),
      ],
      1,
      NOW,
    );

    expect(states.get("expired-high")).toBe("expired");
    expect(states.get("live-low")).toBe("injected");
  });

  it("排序口径和注入查询一致:weight desc, created_at desc", () => {
    const states = resolveFeedbackNoteInjectionStates(
      [
        candidate({ id: "old-high", weight: 500, createdAt: "2026-01-01T00:00:00Z" }),
        candidate({ id: "new-low", weight: 100, createdAt: "2026-07-01T00:00:00Z" }),
        candidate({ id: "new-high", weight: 500, createdAt: "2026-07-01T00:00:00Z" }),
      ],
      2,
      NOW,
    );

    expect(states.get("new-high")).toBe("injected");
    expect(states.get("old-high")).toBe("injected");
    expect(states.get("new-low")).toBe("over_limit");
  });

  it("scope 笔记只和会同时在场的笔记抢名额:B 号的笔记挤不掉 A 号的", () => {
    const states = resolveFeedbackNoteInjectionStates(
      [
        candidate({ id: "b1", weight: 900, douyinAccountId: "account-b" }),
        candidate({ id: "b2", weight: 800, douyinAccountId: "account-b" }),
        candidate({ id: "a1", weight: 100, douyinAccountId: "account-a" }),
      ],
      1,
      NOW,
    );

    // A 号的单子上,候选集里根本没有 B 号的笔记 —— a1 是第一名,会生效。
    expect(states.get("a1")).toBe("injected");
    expect(states.get("b1")).toBe("injected");
    expect(states.get("b2")).toBe("over_limit");
  });

  it("归档 / 被取代的笔记是 inactive", () => {
    const states = resolveFeedbackNoteInjectionStates(
      [
        candidate({ id: "archived", status: "archived" }),
        candidate({ id: "superseded", status: "superseded" }),
      ],
      10,
      NOW,
    );

    expect(states.get("archived")).toBe("inactive");
    expect(states.get("superseded")).toBe("inactive");
  });

  it("limit=0(关闭注入)时,没有任何笔记会生效 —— UI 不许再说「下次会照做」", () => {
    const states = resolveFeedbackNoteInjectionStates([candidate({ id: "n1" })], 0, NOW);

    expect(states.get("n1")).toBe("over_limit");
  });
});

describeEmbeddedPostgres("agent feedback notes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof agentFeedbackNoteService>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-feedback-notes-");
    db = createDb(tempDb.connectionString);
    svc = agentFeedbackNoteService(db);

    const company = await db
      .insert(companies)
      .values({
        name: `Feedback ${randomUUID()}`,
        issuePrefix: `FB${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;

    const agent = await db
      .insert(agents)
      .values({ companyId, name: "文案编导", role: "文案编导" })
      .returning()
      .then((rows) => rows[0]!);
    agentId = agent.id;
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function addNote(input: {
    kind: "correction" | "reminder" | "preference";
    content: string;
    weight?: number;
    status?: "active" | "archived" | "superseded";
    douyinAccountId?: string | null;
    agent?: string;
  }) {
    return db
      .insert(agentFeedbackNotes)
      .values({
        companyId,
        agentId: input.agent ?? agentId,
        kind: input.kind,
        content: input.content,
        sourceType: "manual",
        scopeType: input.douyinAccountId ? "douyin_account" : "global",
        douyinAccountId: input.douyinAccountId ?? null,
        status: input.status ?? "active",
        ...(input.weight === undefined ? {} : { weight: input.weight }),
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("only active notes are injectable, ordered by weight then recency", async () => {
    await db.delete(agentFeedbackNotes);
    await addNote({ kind: "correction", content: "低权重", weight: 10 });
    await addNote({ kind: "correction", content: "高权重", weight: 900 });
    await addNote({ kind: "reminder", content: "已归档的别注入", weight: 999, status: "archived" });

    const notes = await svc.listInjectable({ agentId, limit: 10 });
    expect(notes.map((note) => note.content)).toEqual(["高权重", "低权重"]);
  });

  it("scope filtering keeps account A's notes out of account B's run", async () => {
    await db.delete(agentFeedbackNotes);
    const makeAccount = async (nickname: string) =>
      db
        .insert(douyinAccounts)
        .values({ companyId, nickname })
        .returning()
        .then((rows) => rows[0]!);
    const accountA = await makeAccount("小镜说法A");
    const accountB = await makeAccount("小镜说法B");

    await addNote({ kind: "correction", content: "全局:法条引用要带条号" });
    await addNote({ kind: "correction", content: "A 号不让说家人们", douyinAccountId: accountA.id });
    await addNote({ kind: "correction", content: "B 号要口语化", douyinAccountId: accountB.id });

    const forA = await svc.listInjectable({ agentId, douyinAccountId: accountA.id, limit: 10 });
    expect(forA.map((n) => n.content).sort()).toEqual(
      ["A 号不让说家人们", "全局:法条引用要带条号"].sort(),
    );
    // B 号的笔记不能污染 A 号的输出
    expect(forA.map((n) => n.content)).not.toContain("B 号要口语化");

    // 不带 scope 时只拿全局笔记
    const globalOnly = await svc.listInjectable({ agentId, limit: 10 });
    expect(globalOnly.map((n) => n.content)).toEqual(["全局:法条引用要带条号"]);
  });

  it("the inject query runs as an ordered Index Scan on inject_idx, not a Seq Scan", async () => {
    await db.delete(agentFeedbackNotes);
    // 造够量,否则 planner 对小表一律 Seq Scan,证明不了什么
    await db.execute(sql`
      INSERT INTO agent_feedback_notes (company_id, agent_id, kind, content, source_type, weight, status)
      SELECT ${companyId}::uuid, ${agentId}::uuid, 'correction', 'note ' || g, 'manual',
             (random() * 500)::int, 'active'
      FROM generate_series(1, 50000) g
    `);
    await db.execute(sql`ANALYZE agent_feedback_notes`);

    const query = buildInjectableNotesQuery(db, { agentId, douyinAccountId: null, projectId: null, limit: 10 });
    const compiled = query.toSQL();
    // 把参数内联进去以便 EXPLAIN(测试里都是我们自己生成的 uuid / 数字,不涉及注入)
    const inlined = compiled.sql.replace(/\$(\d+)/g, (_match, index) => {
      const param = compiled.params[Number(index) - 1];
      return typeof param === "number" ? String(param) : `'${String(param)}'`;
    });

    const plan = await db
      .execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS) ${inlined}`))
      .then((rows) => (rows as unknown as Array<{ "QUERY PLAN": string }>).map((r) => r["QUERY PLAN"]).join("\n"));

    // eslint-disable-next-line no-console
    console.log("\n=== EXPLAIN ANALYZE (inject query, 50k notes) ===\n" + plan + "\n");

    expect(plan).toContain("agent_feedback_notes_inject_idx");
    expect(plan).toMatch(/Index Scan/);
    expect(plan).not.toMatch(/Seq Scan on agent_feedback_notes/);
    // 有序索引 + LIMIT ⇒ 读满 N 行即停,不需要把 5 万行取回来排序
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it("injection writes back times_applied / last_applied_at, and the rendered prompt carries the notes", async () => {
    await db.delete(agentFeedbackNotes);
    await addNote({ kind: "correction", content: "标题太标题党了,别再用「震惊」体", weight: 300 });
    await addNote({ kind: "correction", content: "法条引用必须带条号,别只说《民法典》", weight: 200 });
    await addNote({ kind: "correction", content: "结尾别承诺「一定能赢」,合规红线", weight: 100 });
    await addNote({ kind: "reminder", content: "下次先确认客户是否同意露脸", weight: 50 });

    const issue = await db
      .insert(issues)
      .values({ companyId, title: "写一条「租房押金不退」的短视频脚本", status: "todo" })
      .returning()
      .then((rows) => rows[0]!);

    const notes = await loadFeedbackNotesForPrompt(db, { agentId, issueId: issue.id });
    expect(notes).toHaveLength(4);

    const markdown = buildPaperclipTaskMarkdown({
      issue: { id: issue.id, identifier: "JIN-61", title: issue.title },
      feedbackNotes: notes,
    })!;

    // eslint-disable-next-line no-console
    console.log("\n=== 实际拼进 prompt 的 task markdown ===\n" + markdown + "\n");

    expect(markdown).toContain("别再用「震惊」体");
    expect(markdown).toContain("法条引用必须带条号");
    expect(markdown).toContain("下次先确认客户是否同意露脸");

    const applied = await db
      .select({ timesApplied: agentFeedbackNotes.timesApplied, lastAppliedAt: agentFeedbackNotes.lastAppliedAt })
      .from(agentFeedbackNotes)
      .where(eq(agentFeedbackNotes.agentId, agentId));
    expect(applied.every((row) => row.timesApplied === 1)).toBe(true);
    expect(applied.every((row) => row.lastAppliedAt !== null)).toBe(true);
  });

  it("a run scoped to a squad's douyin account picks up that account's notes", async () => {
    await db.delete(agentFeedbackNotes);
    const account = await db
      .insert(douyinAccounts)
      .values({ companyId, nickname: "小镜说法" })
      .returning()
      .then((rows) => rows[0]!);
    const squad = await db
      .insert(squads)
      .values({ companyId, name: "民法小队", douyinAccountId: account.id })
      .returning()
      .then((rows) => rows[0]!);
    const issue = await db
      .insert(issues)
      .values({ companyId, title: "账号专属选题", status: "todo", ownerSquadId: squad.id })
      .returning()
      .then((rows) => rows[0]!);

    await addNote({ kind: "correction", content: "这个号不让说家人们", douyinAccountId: account.id });

    // scope 从 issue → owner squad → douyin account 解出来
    const notes = await loadFeedbackNotesForPrompt(db, { agentId, issueId: issue.id });
    expect(notes.map((n) => n.content)).toContain("这个号不让说家人们");
  });

  // JIN-80 的核心不变量:**主页标成「会生效」的那批,必须就是 prompt 真的会吃到的那批。**
  // 展示走 list(limit 100、不过滤过期),注入走 buildInjectableNotesQuery(limit 10、过滤过期)——
  // 两条路只要口径不一致,UI 就在替系统撒谎。这条测试把两个集合逐个对上。
  it("列表标为 injected 的集合,和真正注入进 prompt 的集合完全一致", async () => {
    await db.delete(agentFeedbackNotes);
    const injectLimit = resolveFeedbackNoteInjectLimit();

    // 12 条 active(> limit 10)+ 1 条已过期(权重最高,最能骗人)+ 1 条已归档
    for (let index = 0; index < 12; index += 1) {
      await addNote({ kind: "correction", content: `笔记 ${index + 1}`, weight: 500 - index });
    }
    await db.insert(agentFeedbackNotes).values({
      companyId,
      agentId,
      kind: "reminder",
      content: "这条已经过期了,但主页以前照样把它画成生效",
      sourceType: "manual",
      scopeType: "global",
      weight: 999,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await addNote({ kind: "correction", content: "已归档", status: "archived" });

    const listed = await svc.listAnnotated(agentId, {});
    const injected = await svc.listInjectable({ agentId, limit: injectLimit });

    expect(listed.injectLimit).toBe(injectLimit);
    expect(listed.notes.every((note) => note.injectLimit === injectLimit)).toBe(true);
    expect(
      listed.notes
        .filter((note) => note.injection === "injected")
        .map((note) => note.id)
        .sort(),
    ).toEqual(injected.map((note) => note.id).sort());

    // 而且「看得见但不会生效」的那批确实存在,并且被如实标了出来。
    const expired = listed.notes.find((note) => note.content.startsWith("这条已经过期了"));
    expect(expired?.injection).toBe("expired");
    expect(listed.notes.filter((note) => note.injection === "over_limit").length).toBeGreaterThan(0);
  });

  it("archiving a note takes it out of injection immediately", async () => {
    await db.delete(agentFeedbackNotes);
    const note = await addNote({ kind: "correction", content: "这条马上要被归档" });
    expect(await svc.listInjectable({ agentId, limit: 10 })).toHaveLength(1);

    await svc.update(note.id, { status: "archived" });
    expect(await svc.listInjectable({ agentId, limit: 10 })).toHaveLength(0);
  });
});
