import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentFeedbackNoteDto,
  squadDispatchDto,
  squadDto,
  squadMemberDto,
} from "@paperclipai/shared";

/**
 * 契约的**运行时**这一半。
 *
 * `packages/shared/src/dto/contract.test.ts` 钉的是「DTO 有没有被改坏」;
 * 这里钉的是「路由真的按 DTO 出参了吗」—— 两者缺一不可:
 * DTO 写得再漂亮,只要哪条路由还在 `res.json(row)`,契约就是假的。
 *
 * 手法:让 service 返回一条**多带了一列**的表行(`internalRoutingSecret`),
 * 那正是「6 个 agent 在并行加字段」时天天发生的事。
 * 裸表行直出 → 这一列出线 → strict parse 失败 → 红。
 * 走了 DTO → 它压根到不了线上。
 */

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const SQUAD_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const DISPATCH_ID = "55555555-5555-4555-8555-555555555555";
const NOTE_ID = "66666666-6666-4666-8666-666666666666";
const MEMBER_ID = "77777777-7777-4777-8777-777777777777";

const NOW = new Date("2026-07-15T02:00:00.000Z");

/** 明天某个迁移加的列。今天没人声明它是对外契约 —— 那它就不该出线。 */
const LEAKY_COLUMN = { internalRoutingSecret: "internal-only" } as const;

const squadRow = {
  id: SQUAD_ID,
  companyId: COMPANY_ID,
  projectId: null,
  name: "普法一队",
  description: null,
  leaderAgentId: AGENT_ID,
  douyinAccountId: null,
  status: "active",
  dispatchPolicy: {},
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
  ...LEAKY_COLUMN,
};

const memberRow = {
  id: MEMBER_ID,
  companyId: COMPANY_ID,
  squadId: SQUAD_ID,
  memberType: "agent",
  agentId: AGENT_ID,
  userId: null,
  role: "member",
  position: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...LEAKY_COLUMN,
};

const dispatchRow = {
  id: DISPATCH_ID,
  companyId: COMPANY_ID,
  squadId: SQUAD_ID,
  issueId: ISSUE_ID,
  state: "pending",
  requestedByType: "user",
  requestedByUserId: "user-1",
  requestedByAgentId: null,
  sourceMessageId: null,
  assignedAgentId: null,
  assignedUserId: null,
  decidedByAgentId: null,
  decisionReason: null,
  decidedAt: null,
  failureReason: null,
  attemptCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...LEAKY_COLUMN,
};

const noteRow = {
  id: NOTE_ID,
  companyId: COMPANY_ID,
  agentId: AGENT_ID,
  scopeType: "global",
  douyinAccountId: null,
  projectId: null,
  kind: "correction",
  content: "标题别再用「震惊」体",
  sourceType: "review",
  sourceMessageId: null,
  sourceIssueId: null,
  sourceApprovalId: null,
  createdByUserId: "user-1",
  createdByAgentId: null,
  status: "active",
  weight: 100,
  timesApplied: 0,
  lastAppliedAt: null,
  expiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...LEAKY_COLUMN,
};

const mockSquadService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listMembers: vi.fn(),
  addMember: vi.fn(),
  removeMember: vi.fn(),
  listDispatches: vi.fn(),
  getDispatchById: vi.fn(),
  decide: vi.fn(),
  reassign: vi.fn(),
  decline: vi.fn(),
}));

const mockFeedbackNoteService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  squadService: () => mockSquadService,
  agentFeedbackNoteService: () => mockFeedbackNoteService,
  heartbeatService: () => ({}),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn().mockResolvedValue(undefined),
}));

/** `agent-feedback-notes.ts` 的 loadAgentForRequest 直接打 db 取 agent。 */
let dbRows: unknown[] = [];
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(dbRows).then(resolve),
      }),
    }),
  }),
} as never;

async function createApp() {
  vi.resetModules();
  const [{ errorHandler }, { squadRoutes }, { agentFeedbackNoteRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/squads.js") as Promise<typeof import("../routes/squads.js")>,
    import("../routes/agent-feedback-notes.js") as Promise<
      typeof import("../routes/agent-feedback-notes.js")
    >,
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
  app.use("/api", squadRoutes(fakeDb));
  app.use("/api", agentFeedbackNoteRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

/**
 * 显式 127.0.0.1 —— 这个沙箱(WSL)没有 IPv6 回环,supertest 默认绑 ::1 会 EADDRNOTAVAIL。
 * 不是代码问题,别去改路由。
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

describe.sequential("协作层路由的响应契约", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbRows = [{ id: AGENT_ID, companyId: COMPANY_ID }];
  });

  it("GET /companies/:id/squads —— 表行里的未声明列不出线", async () => {
    mockSquadService.list.mockResolvedValue([squadRow]);
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).get(`/api/companies/${COMPANY_ID}/squads`),
    );

    expect(res.status).toBe(200);
    expect(() => squadDto.array().parse(res.body)).not.toThrow();
    expect(res.body[0]).not.toHaveProperty("internalRoutingSecret");
    // 时间戳出线是 ISO 字符串 —— 由 mapper 显式转,不是 JSON.stringify 的副作用
    expect(res.body[0].createdAt).toBe("2026-07-15T02:00:00.000Z");
  });

  it("GET /squads/:id", async () => {
    mockSquadService.getById.mockResolvedValue(squadRow);
    const app = await createApp();
    const res = await requestApp(app, (base) => request(base).get(`/api/squads/${SQUAD_ID}`));

    expect(res.status).toBe(200);
    expect(() => squadDto.parse(res.body)).not.toThrow();
    expect(res.body).not.toHaveProperty("internalRoutingSecret");
  });

  it("POST /companies/:id/squads", async () => {
    mockSquadService.create.mockResolvedValue(squadRow);
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).post(`/api/companies/${COMPANY_ID}/squads`).send({ name: "普法一队" }),
    );

    expect(res.status).toBe(201);
    expect(() => squadDto.parse(res.body)).not.toThrow();
  });

  it("GET /squads/:id/members —— 成员只有 id + 角色,没有内嵌 agent 对象(前端曾以为有)", async () => {
    mockSquadService.getById.mockResolvedValue(squadRow);
    mockSquadService.listMembers.mockResolvedValue([memberRow]);
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).get(`/api/squads/${SQUAD_ID}/members`),
    );

    expect(res.status).toBe(200);
    expect(() => squadMemberDto.array().parse(res.body)).not.toThrow();
    expect(res.body[0]).not.toHaveProperty("agent");
    expect(res.body[0]).not.toHaveProperty("internalRoutingSecret");
  });

  it("POST /squads/:id/members", async () => {
    mockSquadService.getById.mockResolvedValue(squadRow);
    mockSquadService.addMember.mockResolvedValue(memberRow);
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/squads/${SQUAD_ID}/members`)
        .send({ memberType: "agent", agentId: AGENT_ID }),
    );

    expect(res.status).toBe(201);
    expect(() => squadMemberDto.parse(res.body)).not.toThrow();
  });

  it("GET /squads/:id/dispatches", async () => {
    mockSquadService.getById.mockResolvedValue(squadRow);
    mockSquadService.listDispatches.mockResolvedValue([dispatchRow]);
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).get(`/api/squads/${SQUAD_ID}/dispatches`),
    );

    expect(res.status).toBe(200);
    expect(() => squadDispatchDto.array().parse(res.body)).not.toThrow();
    expect(res.body[0]).not.toHaveProperty("internalRoutingSecret");
  });

  it("POST /squad-dispatches/:id/decide", async () => {
    mockSquadService.getDispatchById.mockResolvedValue(dispatchRow);
    mockSquadService.decide.mockResolvedValue({
      ...dispatchRow,
      state: "dispatched",
      assignedAgentId: AGENT_ID,
      decisionReason: "他写过同类选题",
      decidedAt: NOW,
    });
    dbRows = []; // wakeAssignedAgent 查不到 issue 就直接返回 —— 这里只关心响应形状
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/squad-dispatches/${DISPATCH_ID}/decide`)
        .send({ assignedAgentId: AGENT_ID, decisionReason: "他写过同类选题" }),
    );

    expect(res.status).toBe(200);
    expect(() => squadDispatchDto.parse(res.body)).not.toThrow();
    expect(res.body.decidedAt).toBe("2026-07-15T02:00:00.000Z");
    expect(res.body).not.toHaveProperty("internalRoutingSecret");
  });

  it("GET /agents/:id/feedback-notes —— 没有 scopeLabel / sourceLabel(前端曾以为有)", async () => {
    mockFeedbackNoteService.list.mockResolvedValue([noteRow]);
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).get(`/api/agents/${AGENT_ID}/feedback-notes`),
    );

    expect(res.status).toBe(200);
    expect(() => agentFeedbackNoteDto.array().parse(res.body)).not.toThrow();
    expect(res.body[0]).not.toHaveProperty("scopeLabel");
    expect(res.body[0]).not.toHaveProperty("sourceLabel");
    expect(res.body[0]).not.toHaveProperty("internalRoutingSecret");
  });

  it("POST /agents/:id/feedback-notes", async () => {
    mockFeedbackNoteService.create.mockResolvedValue(noteRow);
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${AGENT_ID}/feedback-notes`)
        .send({ kind: "correction", content: "标题别再用「震惊」体", sourceType: "review" }),
    );

    expect(res.status).toBe(201);
    expect(() => agentFeedbackNoteDto.parse(res.body)).not.toThrow();
  });

  it("PATCH /agent-feedback-notes/:id", async () => {
    mockFeedbackNoteService.getById.mockResolvedValue(noteRow);
    mockFeedbackNoteService.update.mockResolvedValue({ ...noteRow, status: "archived" });
    const app = await createApp();
    const res = await requestApp(app, (base) =>
      request(base).patch(`/api/agent-feedback-notes/${NOTE_ID}`).send({ status: "archived" }),
    );

    expect(res.status).toBe(200);
    expect(() => agentFeedbackNoteDto.parse(res.body)).not.toThrow();
    expect(res.body.status).toBe("archived");
    expect(res.body).not.toHaveProperty("internalRoutingSecret");
  });
});

/**
 * OpenAPI 这一半:规格里的响应形状必须**来自同一批 DTO**。
 *
 * 之前这几条路由在规格里写的是 `r.ok()` —— 「200,内容随缘」。
 * 那种文档比没有更糟:它让人以为自己在读契约,其实什么也没承诺。
 */
describe("OpenAPI 规格从 DTO 生成", () => {
  it("四条对外资源都注册成了 components", async () => {
    const { buildOpenApiSpec } = await import("../routes/openapi.js");
    const spec = buildOpenApiSpec() as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };

    for (const name of ["Squad", "SquadMember", "SquadDispatch", "AgentFeedbackNote"]) {
      expect(spec.components.schemas[name]).toBeDefined();
    }
    // 契约里声明了什么,components 里就有什么 —— 不是手写的近似值
    expect(Object.keys(spec.components.schemas.Squad!.properties ?? {})).toEqual(
      Object.keys(squadDto.shape),
    );
    expect(Object.keys(spec.components.schemas.AgentFeedbackNote!.properties ?? {})).toEqual(
      Object.keys(agentFeedbackNoteDto.shape),
    );
  });

  it("路由响应指向 DTO,不再是「200,内容随缘」", async () => {
    const { buildOpenApiSpec } = await import("../routes/openapi.js");
    const spec = buildOpenApiSpec() as { paths: Record<string, any> };

    const listNotes =
      spec.paths["/api/agents/{id}/feedback-notes"].get.responses["200"].content[
        "application/json"
      ].schema;
    expect(listNotes).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/AgentFeedbackNote" },
    });

    const getSquad =
      spec.paths["/api/squads/{id}"].get.responses["200"].content["application/json"].schema;
    expect(getSquad).toEqual({ $ref: "#/components/schemas/Squad" });

    // 改派开的是新派单(201),形状同样是 SquadDispatch
    const reassign =
      spec.paths["/api/squad-dispatches/{id}/decide"].post.responses["201"].content[
        "application/json"
      ].schema;
    expect(reassign).toEqual({ $ref: "#/components/schemas/SquadDispatch" });
  });
});
