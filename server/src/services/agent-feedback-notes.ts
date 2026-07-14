import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentFeedbackNotes, issues, squads } from "@paperclipai/db";
import {
  DEFAULT_AGENT_FEEDBACK_NOTE_INJECT_LIMIT,
  MAX_AGENT_FEEDBACK_NOTE_INJECT_LIMIT,
  type AgentFeedbackNoteKind,
  type AgentFeedbackNoteScopeType,
  type AgentFeedbackNoteStatus,
  type CreateAgentFeedbackNote,
  type UpdateAgentFeedbackNote,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

export type InjectableFeedbackNote = {
  id: string;
  kind: AgentFeedbackNoteKind;
  content: string;
};

/**
 * 注入条数上限:注意力有限,不能把所有笔记都塞进 prompt。
 * 默认 10,可用 PAPERCLIP_AGENT_FEEDBACK_NOTE_INJECT_LIMIT 覆盖(0 = 关闭注入)。
 */
export function resolveFeedbackNoteInjectLimit(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.PAPERCLIP_AGENT_FEEDBACK_NOTE_INJECT_LIMIT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_AGENT_FEEDBACK_NOTE_INJECT_LIMIT;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AGENT_FEEDBACK_NOTE_INJECT_LIMIT;
  return Math.min(parsed, MAX_AGENT_FEEDBACK_NOTE_INJECT_LIMIT);
}

/**
 * prompt 注入热路径的取数。
 *
 * ⚠️ WHERE / ORDER BY 的形状必须和 `agent_feedback_notes_inject_idx`
 * (agent_id, weight DESC, created_at DESC) WHERE status='active' 对齐:
 *   WHERE agent_id = ? AND status = 'active'
 *   ORDER BY weight DESC, created_at DESC
 *   LIMIT N
 * scope 过滤(douyin_account_id / project_id)只能作为**回查 filter**,
 * 绝不能进 ORDER BY 前缀 —— 架构师实测:进了前缀会退化成 Seq Scan 45,000 行 / 15.9ms,
 * 不进是有序 Index Scan 读满 N 行即停 / 0.30ms(约 45 倍)。
 */
export function buildInjectableNotesQuery(
  dbOrTx: Pick<Db, "select">,
  input: { agentId: string; douyinAccountId?: string | null; projectId?: string | null; limit: number },
) {
  const scopeFilters = [isNull(agentFeedbackNotes.douyinAccountId)];
  if (input.douyinAccountId) {
    scopeFilters.push(eq(agentFeedbackNotes.douyinAccountId, input.douyinAccountId));
  }
  const projectFilters = [isNull(agentFeedbackNotes.projectId)];
  if (input.projectId) {
    projectFilters.push(eq(agentFeedbackNotes.projectId, input.projectId));
  }

  return dbOrTx
    .select({
      id: agentFeedbackNotes.id,
      kind: agentFeedbackNotes.kind,
      content: agentFeedbackNotes.content,
    })
    .from(agentFeedbackNotes)
    .where(
      and(
        eq(agentFeedbackNotes.agentId, input.agentId),
        eq(agentFeedbackNotes.status, "active"),
        // 过期笔记不注入(expires_at 为空 = 永不过期)
        or(isNull(agentFeedbackNotes.expiresAt), sql`${agentFeedbackNotes.expiresAt} > now()`),
        // scope 回查:全局笔记 + 命中当前账号/项目的笔记
        or(...scopeFilters),
        or(...projectFilters),
      ),
    )
    .orderBy(desc(agentFeedbackNotes.weight), desc(agentFeedbackNotes.createdAt))
    .limit(input.limit);
}

/**
 * 注入文案:「最近被纠正」与「下次注意」分开呈现,别糊成一坨 ——
 * 前者是已经犯过的错(correction),后者是要提前留意的偏好(reminder / preference)。
 */
export function renderFeedbackNotesSection(notes: InjectableFeedbackNote[]): string | null {
  if (notes.length === 0) return null;

  const corrections = notes.filter((note) => note.kind === "correction");
  const reminders = notes.filter((note) => note.kind === "reminder");
  const preferences = notes.filter((note) => note.kind === "preference");

  const lines = [
    "Your feedback notes (learned from past work on this company — apply them to this task):",
  ];
  if (corrections.length > 0) {
    lines.push("", "Recently corrected (do not repeat these mistakes):");
    for (const note of corrections) lines.push(`- ${note.content}`);
  }
  if (reminders.length > 0) {
    lines.push("", "Watch out for next time:");
    for (const note of reminders) lines.push(`- ${note.content}`);
  }
  if (preferences.length > 0) {
    lines.push("", "Standing preferences:");
    for (const note of preferences) lines.push(`- ${note.content}`);
  }
  return lines.join("\n");
}

/**
 * 一轮 run 的注入取数 + 回写:
 *   1) 解出这条 issue 的 scope(项目 / 小队绑定的抖音账号)
 *   2) 走 inject_idx 取 top-N
 *   3) 回写 times_applied / last_applied_at —— 哪些笔记真的在起作用,产品要展示
 * 任何一步失败都不该拖垮 run:笔记是增强项,不是必需项。
 */
export async function loadFeedbackNotesForPrompt(
  db: Db,
  input: { agentId: string; issueId?: string | null; limit?: number },
): Promise<InjectableFeedbackNote[]> {
  const limit = input.limit ?? resolveFeedbackNoteInjectLimit();
  if (limit <= 0) return [];

  let projectId: string | null = null;
  let douyinAccountId: string | null = null;
  if (input.issueId) {
    const scope = await db
      .select({
        projectId: issues.projectId,
        douyinAccountId: squads.douyinAccountId,
      })
      .from(issues)
      .leftJoin(squads, eq(squads.id, issues.ownerSquadId))
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0] ?? null);
    projectId = scope?.projectId ?? null;
    douyinAccountId = scope?.douyinAccountId ?? null;
  }

  const notes = (await buildInjectableNotesQuery(db, {
    agentId: input.agentId,
    douyinAccountId,
    projectId,
    limit,
  })) as InjectableFeedbackNote[];

  if (notes.length > 0) {
    await db
      .update(agentFeedbackNotes)
      .set({
        timesApplied: sql`${agentFeedbackNotes.timesApplied} + 1`,
        lastAppliedAt: new Date(),
      })
      .where(inArray(agentFeedbackNotes.id, notes.map((note) => note.id)));
  }
  return notes;
}

export function agentFeedbackNoteService(db: Db) {
  return {
    list: (
      agentId: string,
      filters: {
        status?: AgentFeedbackNoteStatus;
        kind?: AgentFeedbackNoteKind;
        scopeType?: AgentFeedbackNoteScopeType;
        douyinAccountId?: string;
        projectId?: string;
        limit?: number;
      } = {},
    ) => {
      const conditions = [eq(agentFeedbackNotes.agentId, agentId)];
      if (filters.status) conditions.push(eq(agentFeedbackNotes.status, filters.status));
      if (filters.kind) conditions.push(eq(agentFeedbackNotes.kind, filters.kind));
      if (filters.scopeType) conditions.push(eq(agentFeedbackNotes.scopeType, filters.scopeType));
      if (filters.douyinAccountId) {
        conditions.push(eq(agentFeedbackNotes.douyinAccountId, filters.douyinAccountId));
      }
      if (filters.projectId) conditions.push(eq(agentFeedbackNotes.projectId, filters.projectId));
      return db
        .select()
        .from(agentFeedbackNotes)
        .where(and(...conditions))
        .orderBy(desc(agentFeedbackNotes.weight), desc(agentFeedbackNotes.createdAt))
        .limit(filters.limit ?? 100);
    },

    getById: (id: string) =>
      db
        .select()
        .from(agentFeedbackNotes)
        .where(eq(agentFeedbackNotes.id, id))
        .then((rows) => rows[0] ?? null),

    create: (
      input: CreateAgentFeedbackNote & {
        companyId: string;
        agentId: string;
        createdByUserId?: string | null;
        createdByAgentId?: string | null;
      },
    ) =>
      db
        .insert(agentFeedbackNotes)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          kind: input.kind,
          content: input.content,
          scopeType: input.scopeType ?? "global",
          douyinAccountId: input.douyinAccountId ?? null,
          projectId: input.projectId ?? null,
          sourceType: input.sourceType,
          sourceMessageId: input.sourceMessageId ?? null,
          sourceIssueId: input.sourceIssueId ?? null,
          sourceApprovalId: input.sourceApprovalId ?? null,
          createdByUserId: input.createdByUserId ?? null,
          createdByAgentId: input.createdByAgentId ?? null,
          ...(input.weight === undefined ? {} : { weight: input.weight }),
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        })
        .returning()
        .then((rows) => rows[0]!),

    update: async (id: string, data: UpdateAgentFeedbackNote) => {
      const patch: Partial<typeof agentFeedbackNotes.$inferInsert> = { updatedAt: new Date() };
      if (data.status !== undefined) patch.status = data.status;
      if (data.weight !== undefined) patch.weight = data.weight;
      if (data.content !== undefined) patch.content = data.content;
      const updated = await db
        .update(agentFeedbackNotes)
        .set(patch)
        .where(eq(agentFeedbackNotes.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) throw notFound("Feedback note not found");
      return updated;
    },

    listInjectable: (input: {
      agentId: string;
      douyinAccountId?: string | null;
      projectId?: string | null;
      limit?: number;
    }) =>
      buildInjectableNotesQuery(db, {
        agentId: input.agentId,
        douyinAccountId: input.douyinAccountId ?? null,
        projectId: input.projectId ?? null,
        limit: input.limit ?? resolveFeedbackNoteInjectLimit(),
      }) as Promise<InjectableFeedbackNote[]>,

    /** 注入后回写使用计数:哪些笔记真的在起作用,产品要展示 */
    markApplied: async (noteIds: string[]) => {
      if (noteIds.length === 0) return;
      await db
        .update(agentFeedbackNotes)
        .set({
          timesApplied: sql`${agentFeedbackNotes.timesApplied} + 1`,
          lastAppliedAt: new Date(),
        })
        .where(inArray(agentFeedbackNotes.id, noteIds));
    },
  };
}
