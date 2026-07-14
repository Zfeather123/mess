import { z } from "zod";
import { PROFILE_FACT_SOURCES } from "../account-profile-spec.js";
import { dtoJsonObject, dtoTimestamp, dtoUuid } from "./primitives.js";

/**
 * 账号档案 / TikHub 同步的**响应契约**(JIN-54)。
 *
 * 这些路由是在 #40 立规矩之前合入的,当时是裸表行直出(`res.json({ profile, ... })`)——
 * 也就是说 `account_profiles` / `douyin_accounts` 的**每一列**都成了对前端的隐式承诺,
 * 包括 `raw_profile`(TikHub 的原始响应,几十 KB,而且里面有什么我们自己都不完全知道)。
 * 这里补登记,顺手把不该出线的东西关回去。
 */

/**
 * ⚠️ `curatedSnapshot` 是 `dtoJsonObject()` 而不是逐字段声明 —— 这是**刻意**的,不是偷懒。
 *
 * 它的形状由 `PROFILE_FIELD_SPEC[specVersion]` 决定,而 spec 是**会升版的**(v1 → v2 加字段)。
 * 如果把 v1 的字段逐个写进契约,那么「档案规格升版」这件本该向前兼容的事,
 * 会在契约闸门上变成一次破坏性变更 —— 用错误的地方拦错误的东西。
 * 真正的形状约束在 spec 那一层(有 12 个单测钉着),契约这层只保证「是个对象」。
 * `specVersion` 显式出线,前端据它决定怎么读。
 */
export const accountProfileDto = z
  .object({
    id: dtoUuid(),
    companyId: dtoUuid(),
    douyinAccountId: dtoUuid(),
    positioning: z.string().nullable(),
    targetAudience: z.string().nullable(),
    tonePreferences: z.array(z.string()),
    bannedExpressions: z.array(z.string()),
    effectiveMethods: z.array(dtoJsonObject()),
    curatedSnapshot: dtoJsonObject(),
    completenessPct: z.number().int(),
    missingFields: z.array(z.string()),
    specVersion: z.string(),
    /** 缓存失效用:每次 recompute 自增。前端据它判断「档案变了没」,不用比整个 snapshot */
    revision: z.number().int(),
    lastCuratedAt: dtoTimestamp().nullable(),
    createdAt: dtoTimestamp(),
    updatedAt: dtoTimestamp(),
  })
  .strict();
export type AccountProfileDto = z.infer<typeof accountProfileDto>;

/**
 * 抖音账号概览。
 *
 * **`rawProfile` 不出线** —— 那是 TikHub 的原始透传响应(字段名我们自己都标着「待实测」)。
 * 一旦对外发,前端总有一天会去读 `rawProfile.user.xxx`,而那个 key 会在抖音下次改版时消失。
 * 契约的意义就是把这种「能读但不该读」的东西挡在门外。
 */
export const douyinAccountDto = z
  .object({
    id: dtoUuid(),
    companyId: dtoUuid(),
    secUid: z.string().nullable(),
    uniqueId: z.string().nullable(),
    nickname: z.string(),
    avatarUrl: z.string().nullable(),
    signature: z.string().nullable(),
    followerCount: z.number().int(),
    followingCount: z.number().int(),
    awemeCount: z.number().int(),
    totalFavorited: z.number().int(),
    status: z.string(),
    /** 「数据更新于 X」—— 前端就靠它显示新鲜度,null = 从没同步过 */
    tikhubSyncedAt: dtoTimestamp().nullable(),
    tikhubSyncError: z.string().nullable(),
    createdAt: dtoTimestamp(),
    updatedAt: dtoTimestamp(),
  })
  .strict();
export type DouyinAccountDto = z.infer<typeof douyinAccountDto>;

/** 每个来源的同步状态(原型第 7 张图那一排状态行) */
export const profileSyncSourceDto = z
  .object({
    id: dtoUuid(),
    profileId: dtoUuid(),
    source: z.enum(["user", "tikhub", "resume", "history_content"]),
    status: z.enum(["never_synced", "syncing", "synced", "error"]),
    lastSyncedAt: dtoTimestamp().nullable(),
    lastAttemptAt: dtoTimestamp().nullable(),
    lastErrorCode: z.string().nullable(),
    lastErrorMessage: z.string().nullable(),
    attemptCount: z.number().int(),
    factsWritten: z.number().int(),
    updatedAt: dtoTimestamp(),
  })
  .strict();
export type ProfileSyncSourceDto = z.infer<typeof profileSyncSourceDto>;

/** 「缺失信息引导补全」的一项 */
export const profileGuidanceItemDto = z
  .object({
    fieldKey: z.string(),
    label: z.string(),
    weight: z.number().int(),
    required: z.boolean(),
    question: z.string(),
    /** false = 无论怎么同步都补不上,必须问用户(如 禁用表达 —— 合规红线不能由模型代填) */
    canAutoFill: z.boolean(),
    autoFillableFrom: z.array(z.enum(PROFILE_FACT_SOURCES)),
    diagnosisStrategy: z.string(),
  })
  .strict();
export type ProfileGuidanceItemDto = z.infer<typeof profileGuidanceItemDto>;

export const profileGuidanceDto = z
  .object({
    profileId: dtoUuid(),
    completenessPct: z.number().int(),
    missingRequiredFields: z.array(z.string()),
    /** UI 分两栏就靠这两个数组:能同步补的 vs 只能问用户的 */
    autoFillable: z.array(profileGuidanceItemDto),
    needsUser: z.array(profileGuidanceItemDto),
  })
  .strict();
export type ProfileGuidanceDto = z.infer<typeof profileGuidanceDto>;

/**
 * 一次 TikHub 同步的结果。
 *
 * `playCountsFetched` 单独出线是有原因的:播放量必须走专用统计接口(一次最多 2 条),
 * 很容易只补到一部分。前端要能说清「20 条里补到了 12 条播放量」,
 * 而不是让用户以为剩下 8 条真的没人看。
 */
export const douyinSyncResultDto = z
  .object({
    douyinAccountId: dtoUuid(),
    profileId: dtoUuid(),
    videosSynced: z.number().int(),
    playCountsFetched: z.number().int(),
    factsWritten: z.number().int(),
    completenessPct: z.number().int(),
    missingFields: z.array(z.string()),
  })
  .strict();
export type DouyinSyncResultDto = z.infer<typeof douyinSyncResultDto>;

/**
 * 写事实的结果。`applied=false` 必须带 `reason` —— 「静默不写」是排查噩梦。
 */
export const profileFactWriteResultDto = z
  .object({
    fieldKey: z.string(),
    applied: z.boolean(),
    reason: z.enum(["lower_priority", "empty_value", "unknown_field"]).optional(),
  })
  .strict();
export type ProfileFactWriteResultDto = z.infer<typeof profileFactWriteResultDto>;
