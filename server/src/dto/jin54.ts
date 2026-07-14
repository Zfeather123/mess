import { accountProfiles, douyinAccounts, profileSyncSources } from "@paperclipai/db";
import {
  toIso,
  toIsoOrNull,
  type AccountProfileDto,
  type DouyinAccountDto,
  type DouyinSyncResultDto,
  type ProfileFactWriteResultDto,
  type ProfileGuidanceDto,
  type ProfileGuidanceItemDto,
  type ProfileSyncSourceDto,
  type TodayTaskDto,
  type TodayTaskPageDto,
  type TodayTaskSummaryDto,
} from "@paperclipai/shared";

/**
 * 表行 → 响应 DTO(JIN-54:账号档案 / TikHub 同步 / 今日任务)。
 *
 * 纪律同 collab.ts:**逐字段写,不许 `...row`**;入参用 drizzle 的 `$inferSelect`,
 * 列改名在编译期就红,而不是等前端线上读到 undefined。
 *
 * 这批路由是在 #40 立规矩**之前**合入的,当时裸表行直出 —— 等于把
 * `account_profiles` / `douyin_accounts` 的每一列都变成了对前端的隐式承诺,
 * 其中包括 `raw_profile`(TikHub 的原始透传响应)。这次登记顺手把它关回去。
 */

type AccountProfileRow = typeof accountProfiles.$inferSelect;
type DouyinAccountRow = typeof douyinAccounts.$inferSelect;
type ProfileSyncSourceRow = typeof profileSyncSources.$inferSelect;

export function toAccountProfileDto(row: AccountProfileRow): AccountProfileDto {
  return {
    id: row.id,
    companyId: row.companyId,
    douyinAccountId: row.douyinAccountId,
    positioning: row.positioning,
    targetAudience: row.targetAudience,
    tonePreferences: row.tonePreferences,
    bannedExpressions: row.bannedExpressions,
    effectiveMethods: row.effectiveMethods,
    curatedSnapshot: row.curatedSnapshot,
    completenessPct: row.completenessPct,
    missingFields: row.missingFields,
    specVersion: row.specVersion,
    revision: row.revision,
    lastCuratedAt: toIsoOrNull(row.lastCuratedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    // 故意不出线:lastCuratedByAgentId(内务)
  };
}

export function toDouyinAccountDto(row: DouyinAccountRow): DouyinAccountDto {
  return {
    id: row.id,
    companyId: row.companyId,
    secUid: row.secUid,
    uniqueId: row.uniqueId,
    nickname: row.nickname,
    avatarUrl: row.avatarUrl,
    signature: row.signature,
    followerCount: row.followerCount,
    followingCount: row.followingCount,
    awemeCount: row.awemeCount,
    totalFavorited: row.totalFavorited,
    status: row.status,
    tikhubSyncedAt: toIsoOrNull(row.tikhubSyncedAt),
    tikhubSyncError: row.tikhubSyncError,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    // ⚠️ 故意不出线:rawProfile —— TikHub 的原始透传响应,字段名连我们自己都标着「待实测」。
    // 一旦对外发,前端总有一天会去读 rawProfile.user.xxx,而那个 key 会在抖音下次改版时消失。
    // 也不出线:douyinUid / projectId(内务)
  };
}

export function toProfileSyncSourceDto(row: ProfileSyncSourceRow): ProfileSyncSourceDto {
  return {
    id: row.id,
    profileId: row.profileId,
    source: row.source as ProfileSyncSourceDto["source"],
    status: row.status as ProfileSyncSourceDto["status"],
    lastSyncedAt: toIsoOrNull(row.lastSyncedAt),
    lastAttemptAt: toIsoOrNull(row.lastAttemptAt),
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    attemptCount: row.attemptCount,
    factsWritten: row.factsWritten,
    updatedAt: toIso(row.updatedAt),
    // 故意不出线:cursor(TikHub max_cursor,纯内务)/ companyId(路径上已有)
  };
}

/* ------------------------------------------------------------------ *
 * 下面几个入参不是表行,而是 service 的计算结果 —— 依然逐字段映射,
 * 理由一样:service 内部加个字段,不该自动变成对外承诺。
 * ------------------------------------------------------------------ */

type GuidanceItemLike = {
  fieldKey: string;
  label: string;
  weight: number;
  required: boolean;
  question: string;
  canAutoFill: boolean;
  autoFillableFrom: readonly string[];
  diagnosisStrategy: string;
};

function toGuidanceItemDto(item: GuidanceItemLike): ProfileGuidanceItemDto {
  return {
    fieldKey: item.fieldKey,
    label: item.label,
    weight: item.weight,
    required: item.required,
    question: item.question,
    canAutoFill: item.canAutoFill,
    autoFillableFrom: [...item.autoFillableFrom] as ProfileGuidanceItemDto["autoFillableFrom"],
    diagnosisStrategy: item.diagnosisStrategy,
  };
}

export function toProfileGuidanceDto(guidance: {
  profileId: string;
  completenessPct: number;
  missingRequiredFields: readonly string[];
  autoFillable: readonly GuidanceItemLike[];
  needsUser: readonly GuidanceItemLike[];
}): ProfileGuidanceDto {
  return {
    profileId: guidance.profileId,
    completenessPct: guidance.completenessPct,
    missingRequiredFields: [...guidance.missingRequiredFields],
    autoFillable: guidance.autoFillable.map(toGuidanceItemDto),
    needsUser: guidance.needsUser.map(toGuidanceItemDto),
  };
}

export function toDouyinSyncResultDto(result: {
  douyinAccountId: string;
  profileId: string;
  videosSynced: number;
  playCountsFetched: number;
  factsWritten: number;
  completenessPct: number;
  missingFields: readonly string[];
}): DouyinSyncResultDto {
  return {
    douyinAccountId: result.douyinAccountId,
    profileId: result.profileId,
    videosSynced: result.videosSynced,
    playCountsFetched: result.playCountsFetched,
    factsWritten: result.factsWritten,
    completenessPct: result.completenessPct,
    missingFields: [...result.missingFields],
  };
}

export function toProfileFactWriteResultDto(result: {
  fieldKey: string;
  applied: boolean;
  reason?: string;
}): ProfileFactWriteResultDto {
  return {
    fieldKey: result.fieldKey,
    applied: result.applied,
    ...(result.reason ? { reason: result.reason as ProfileFactWriteResultDto["reason"] } : {}),
  };
}

/* ---- 今日任务 ---- */

type TodayTaskLike = {
  issue: {
    id: string;
    companyId: string;
    projectId: string | null;
    parentId: string | null;
    identifier: string | null;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    ownerSquadId: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
  bucket: string;
  progress: { completed: number; total: number; label: string } | null;
  openApprovals: readonly {
    id: string;
    type: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  }[];
};

export function toTodayTaskDto(task: TodayTaskLike): TodayTaskDto {
  const { issue } = task;
  return {
    issue: {
      id: issue.id,
      companyId: issue.companyId,
      projectId: issue.projectId,
      parentId: issue.parentId,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      status: issue.status as TodayTaskDto["issue"]["status"],
      priority: issue.priority as TodayTaskDto["issue"]["priority"],
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      ownerSquadId: issue.ownerSquadId,
      startedAt: toIsoOrNull(issue.startedAt),
      completedAt: toIsoOrNull(issue.completedAt),
      cancelledAt: toIsoOrNull(issue.cancelledAt),
      createdAt: toIso(issue.createdAt),
      updatedAt: toIso(issue.updatedAt),
    },
    bucket: task.bucket as TodayTaskDto["bucket"],
    // progress 为 null 是**合法且常见**的:没有子 issue 就没有分母,如实返回 null,不编百分比
    progress: task.progress
      ? { completed: task.progress.completed, total: task.progress.total, label: task.progress.label }
      : null,
    openApprovals: task.openApprovals.map((approval) => ({
      id: approval.id,
      type: approval.type,
      status: approval.status as TodayTaskDto["openApprovals"][number]["status"],
      createdAt: toIso(approval.createdAt),
      updatedAt: toIso(approval.updatedAt),
    })),
  };
}

export function toTodayTaskPageDto(page: {
  tasks: readonly TodayTaskLike[];
  hasMore: boolean;
  nextCursor: string | null;
}): TodayTaskPageDto {
  return {
    tasks: page.tasks.map(toTodayTaskDto),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

export function toTodayTaskSummaryDto(summary: {
  total: number;
  buckets: readonly { bucket: string; count: number }[];
}): TodayTaskSummaryDto {
  return {
    total: summary.total,
    buckets: summary.buckets.map((entry) => ({
      bucket: entry.bucket as TodayTaskSummaryDto["buckets"][number]["bucket"],
      count: entry.count,
    })),
    // 故意不出线:counts(与 buckets 同一份数据的另一种排列 —— 对外只承诺一种,免得两边漂移)
  };
}
