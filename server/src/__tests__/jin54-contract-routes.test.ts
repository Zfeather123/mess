import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountProfileDto,
  douyinSyncResultDto,
  profileGuidanceDto,
  profileSyncSourceDto,
  todayTaskPageDto,
  todayTaskSummaryDto,
} from "@paperclipai/shared";

/**
 * 账号档案 / TikHub 同步 / 今日任务的**运行时**契约(JIN-54)。
 *
 * 这批路由是在 #40 立规矩**之前**合入的,当时是裸表行直出 —— 于是
 * `account_profiles` / `douyin_accounts` 的每一列都成了对前端的隐式承诺,
 * 其中最危险的是 `raw_profile`:TikHub 的原始透传响应,字段名连我们自己都标着「待实测」。
 * 一旦它出线,前端总有一天会去读 `rawProfile.user.xxx`,而那个 key 会在抖音下次改版时消失。
 *
 * 手法同 collab-contract-routes:让 service 返回**多带了一列**的表行,
 * 裸行直出 → 这列出线 → strict parse 失败 → 红;走了 DTO → 它压根到不了线上。
 */

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const APPROVAL_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_ID = "66666666-6666-4666-8666-666666666666";

const NOW = new Date("2026-07-15T02:00:00.000Z");

/** 明天某个迁移加的列。今天没人声明它是对外契约 —— 那它就不该出线。 */
const LEAKY_COLUMN = { internalRoutingSecret: "internal-only" } as const;

const profileRow = {
  id: PROFILE_ID,
  companyId: COMPANY_ID,
  douyinAccountId: ACCOUNT_ID,
  positioning: "高净值离婚财产分割律师",
  targetAudience: "公司老板",
  tonePreferences: ["像律师说人话"],
  bannedExpressions: ["一定赢"],
  effectiveMethods: [{ method: "开头给身份" }],
  curatedSnapshot: { specVersion: "v1", fields: {} },
  completenessPct: 40,
  missingFields: ["tone_preferences"],
  specVersion: "v1",
  revision: 3,
  lastCuratedByAgentId: null,
  lastCuratedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...LEAKY_COLUMN,
};

const syncSourceRow = {
  id: SOURCE_ID,
  companyId: COMPANY_ID,
  profileId: PROFILE_ID,
  source: "tikhub",
  status: "synced",
  lastSyncedAt: NOW,
  lastAttemptAt: NOW,
  lastErrorCode: null,
  lastErrorMessage: null,
  attemptCount: 1,
  factsWritten: 3,
  // TikHub 的 max_cursor —— 纯内务,不该出线
  cursor: { maxCursor: 1234567890 },
  createdAt: NOW,
  updatedAt: NOW,
  ...LEAKY_COLUMN,
};

const guidance = {
  profileId: PROFILE_ID,
  completenessPct: 40,
  missingRequiredFields: ["tone_preferences"],
  autoFillable: [
    {
      fieldKey: "city",
      label: "执业城市",
      weight: 5,
      required: true,
      question: "你主要在哪个城市执业?",
      canAutoFill: true,
      autoFillableFrom: ["user", "resume", "tikhub"],
      diagnosisStrategy: "TikHub 的 ip_location 可作弱信号。",
    },
  ],
  needsUser: [
    {
      fieldKey: "banned_expressions",
      label: "禁用表达",
      weight: 10,
      required: true,
      question: "有哪些话你绝对不说?",
      canAutoFill: false,
      autoFillableFrom: ["user"],
      diagnosisStrategy: "不自动推断,合规红线只接受用户手填。",
    },
  ],
};

const todayTaskRow = {
  issue: {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: null,
    parentId: null,
    identifier: "JIN-1",
    title: "补充账号档案",
    description: null,
    status: "in_progress",
    priority: "high",
    assigneeAgentId: null,
    assigneeUserId: "user-1",
    ownerSquadId: null,
    startedAt: NOW,
    completedAt: null,
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    // issues 表有 40+ 列(执行层内务),它们**不是**今日任务的对外契约
    executionPolicy: { mode: "normal" },
    checkoutRunId: "run-secret",
    ...LEAKY_COLUMN,
  },
  bucket: "needs_confirmation",
  progress: { completed: 2, total: 5, label: "2/5" },
  openApprovals: [
    {
      id: APPROVAL_ID,
      type: "copy_review",
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
      // 审批的内部裁决字段,不出线
      decisionNote: "internal",
      ...LEAKY_COLUMN,
    },
  ],
};

const mockProfileService = vi.hoisted(() => ({
  getByDouyinAccount: vi.fn(),
  listSyncSources: vi.fn(),
  getGuidance: vi.fn(),
  writeFacts: vi.fn(),
  recompute: vi.fn(),
  getSnapshotForAgent: vi.fn(),
}));

const mockTodayTasksService = vi.hoisted(() => ({
  listForCompany: vi.fn(),
  getSummary: vi.fn(),
}));

const mockSyncService = vi.hoisted(() => ({ syncFromLink: vi.fn() }));

vi.mock("../services/index.js", () => ({
  accountProfileService: () => mockProfileService,
  douyinSyncService: () => mockSyncService,
}));

/** 没有 TIKHUB_API_KEY 时 createTikHubClient() 会抛 —— 测试里注入一个假的,别让它去够真 key。 */
vi.mock("@jin/tikhub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jin/tikhub")>();
  return { ...actual, createTikHubClient: () => ({}) };
});

vi.mock("../services/today-tasks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/today-tasks.js")>();
  return { ...actual, todayTasksService: () => mockTodayTasksService };
});

const fakeDb = {} as never;

async function createApp() {
  vi.resetModules();
  const [{ errorHandler }, { accountProfileRoutes }, { todayTasksRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/account-profiles.js") as Promise<typeof import("../routes/account-profiles.js")>,
    import("../routes/today-tasks.js") as Promise<typeof import("../routes/today-tasks.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", accountProfileRoutes(fakeDb));
  app.use("/api", todayTasksRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

/**
 * 显式 127.0.0.1 —— 这个沙箱(WSL)没有 IPv6 回环,supertest 默认绑 ::1 会 EADDRNOTAVAIL。
 * 是环境问题,不是代码问题:绕开它,别去改被测路由。
 */
async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP port");
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

describe.sequential("账号档案 / 今日任务的响应契约(JIN-54)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET .../profile —— 档案表行里的未声明列不出线", async () => {
    mockProfileService.getByDouyinAccount.mockResolvedValue(profileRow);
    mockProfileService.listSyncSources.mockResolvedValue([syncSourceRow]);
    mockProfileService.getGuidance.mockResolvedValue(guidance);

    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).get(`/api/companies/${COMPANY_ID}/douyin-accounts/${ACCOUNT_ID}/profile`),
    );

    expect(res.status).toBe(200);
    expect(() => accountProfileDto.parse(res.body.profile)).not.toThrow();
    expect(() => profileSyncSourceDto.array().parse(res.body.syncSources)).not.toThrow();
    expect(() => profileGuidanceDto.parse(res.body.guidance)).not.toThrow();

    expect(res.body.profile).not.toHaveProperty("internalRoutingSecret");
    // 内务字段:谁 curate 的、TikHub 翻页游标 —— 都不是对外契约
    expect(res.body.profile).not.toHaveProperty("lastCuratedByAgentId");
    expect(res.body.syncSources[0]).not.toHaveProperty("cursor");
    // 时间戳一律 ISO 字符串出线(不是「JSON.stringify 恰好这么干」,是被契约钉住的)
    expect(res.body.profile.lastCuratedAt).toBe(NOW.toISOString());
  });

  it("GET /profiles/:id/guidance —— 引导补全分两栏,禁用表达永远在「必须问用户」那栏", async () => {
    mockProfileService.getGuidance.mockResolvedValue(guidance);

    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).get(`/api/profiles/${PROFILE_ID}/guidance`),
    );

    expect(res.status).toBe(200);
    expect(() => profileGuidanceDto.parse(res.body)).not.toThrow();
    expect(res.body.needsUser.map((item: { fieldKey: string }) => item.fieldKey)).toContain(
      "banned_expressions",
    );
  });

  it("GET /profiles/:id/sync-sources —— 同步游标不出线", async () => {
    mockProfileService.listSyncSources.mockResolvedValue([syncSourceRow]);

    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).get(`/api/profiles/${PROFILE_ID}/sync-sources`),
    );

    expect(res.status).toBe(200);
    expect(() => profileSyncSourceDto.array().parse(res.body)).not.toThrow();
    expect(res.body[0]).not.toHaveProperty("cursor");
    expect(res.body[0]).not.toHaveProperty("internalRoutingSecret");
  });

  it("GET /today-tasks —— issue 的 40+ 列执行层内务不出线,progress 可以是 null", async () => {
    mockTodayTasksService.listForCompany.mockResolvedValue({
      tasks: [todayTaskRow, { ...todayTaskRow, progress: null }],
      hasMore: false,
      nextCursor: null,
    });

    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).get(`/api/companies/${COMPANY_ID}/today-tasks`),
    );

    expect(res.status).toBe(200);
    expect(() => todayTaskPageDto.parse(res.body)).not.toThrow();

    const issue = res.body.tasks[0].issue;
    expect(issue).not.toHaveProperty("executionPolicy");
    expect(issue).not.toHaveProperty("checkoutRunId");
    expect(issue).not.toHaveProperty("internalRoutingSecret");
    expect(res.body.tasks[0].openApprovals[0]).not.toHaveProperty("decisionNote");

    // 「没有子 issue 就没有分母」—— null 是合法值,前端必须处理这一态,不许被渲染成 0%
    expect(res.body.tasks[1].progress).toBeNull();
  });

  it("GET /today-tasks/summary —— 只承诺 buckets 一种排列(counts 不出线)", async () => {
    mockTodayTasksService.getSummary.mockResolvedValue({
      total: 3,
      buckets: [
        { bucket: "in_progress", count: 1 },
        { bucket: "done", count: 0 },
        { bucket: "needs_confirmation", count: 2 },
        { bucket: "todo", count: 0 },
      ],
      // service 内部的另一种排列 —— 同一份数据发两遍,迟早漂移
      counts: { in_progress: 1, done: 0, needs_confirmation: 2, todo: 0 },
    });

    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).get(`/api/companies/${COMPANY_ID}/today-tasks/summary`),
    );

    expect(res.status).toBe(200);
    expect(() => todayTaskSummaryDto.parse(res.body)).not.toThrow();
    expect(res.body).not.toHaveProperty("counts");
  });

  it("POST /profiles/:id/facts —— 被拒的事实必须带 reason(静默不写是排查噩梦)", async () => {
    mockProfileService.writeFacts.mockResolvedValue({
      results: [
        { fieldKey: "positioning", applied: true },
        { fieldKey: "city", applied: false, reason: "lower_priority" },
      ],
      appliedCount: 1,
    });
    mockProfileService.recompute.mockResolvedValue({
      profile: profileRow,
      completeness: { completenessPct: 40, missingFields: ["tone_preferences"] },
    });

    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/profiles/${PROFILE_ID}/facts`)
        .send({ facts: [{ fieldKey: "positioning", value: "离婚律师" }] }),
    );

    expect(res.status).toBe(200);
    expect(() => accountProfileDto.parse(res.body.profile)).not.toThrow();
    expect(res.body.profile).not.toHaveProperty("internalRoutingSecret");
    expect(res.body.results[1]).toMatchObject({ applied: false, reason: "lower_priority" });
  });
});

describe.sequential("POST 请求体校验(JIN-54)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /douyin-accounts/sync —— 合法请求体不该被 400 掉(回归:schema 曾多包了一层 body)", async () => {
    // 这条是**回归测试**。之前 syncFromLinkSchema 包了一层 `body:`,而 validate() 是
    // `req.body = schema.parse(req.body)` —— parse 的成了 req.body.body(永远 undefined),
    // 于是「粘一条抖音链接 → 预填档案」这条产品主链路**在线上恒 400**,一次都没成功过。
    // 之前没有任何测试真的发过一次 POST,所以没人发现。
    mockSyncService.syncFromLink.mockResolvedValue({
      douyinAccountId: ACCOUNT_ID,
      profileId: PROFILE_ID,
      videosSynced: 20,
      playCountsFetched: 12,
      factsWritten: 3,
      completenessPct: 40,
      missingFields: ["tone_preferences"],
    });

    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/companies/${COMPANY_ID}/douyin-accounts/sync`)
        .send({ link: "7.53 复制打开抖音 https://v.douyin.com/idFqvUms/" }),
    );

    expect(res.status).toBe(200);
    expect(() => douyinSyncResultDto.parse(res.body)).not.toThrow();
    expect(mockSyncService.syncFromLink).toHaveBeenCalledWith(
      COMPANY_ID,
      "7.53 复制打开抖音 https://v.douyin.com/idFqvUms/",
      expect.anything(),
    );
  });

  it("POST /douyin-accounts/sync —— 缺 link 仍然要 400(校验没被我拆掉)", async () => {
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).post(`/api/companies/${COMPANY_ID}/douyin-accounts/sync`).send({}),
    );

    expect(res.status).toBe(400);
  });
});

describe("同步结果契约", () => {
  it("playCountsFetched 单独出线 —— 「补到 12/20 条播放量」必须说得清", () => {
    // 播放量必须走专用统计接口(一次最多 2 条),很容易只补到一部分。
    // 前端要能如实说「20 条里补到 12 条」,而不是让用户以为剩下 8 条真的没人看。
    const parsed = douyinSyncResultDto.parse({
      douyinAccountId: ACCOUNT_ID,
      profileId: PROFILE_ID,
      videosSynced: 20,
      playCountsFetched: 12,
      factsWritten: 3,
      completenessPct: 40,
      missingFields: ["tone_preferences"],
    });
    expect(parsed.playCountsFetched).toBe(12);
  });
});
