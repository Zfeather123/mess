import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  accountProfileFacts,
  accountProfiles,
  douyinAccounts,
  profileSyncSources,
  squadMembers,
  squads,
} from "@paperclipai/db";
import {
  PROFILE_SOURCE_PRIORITY,
  PROFILE_SPEC_VERSION_V1,
  buildProfileGuidance,
  computeProfileCompleteness,
  getProfileFieldSpec,
  isProfileValueFilled,
  type ProfileFactSource,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

export interface FactInput {
  readonly fieldKey: string;
  readonly value: unknown;
  readonly source: ProfileFactSource;
  readonly confidence?: number;
  readonly evidenceRef?: Record<string, unknown> | null;
  readonly createdByAgentId?: string | null;
  readonly createdByUserId?: string | null;
}

export interface FactWriteResult {
  readonly fieldKey: string;
  readonly applied: boolean;
  /** applied=false 时说明为什么被拒 —— 「静默不写」是排查噩梦,拒绝必须有理由 */
  readonly reason?: "lower_priority" | "empty_value" | "unknown_field";
}

/**
 * 账号档案服务 —— 全体 AI 员工的共享记忆底座。
 *
 * 三件事:
 *   1. 写事实(带冲突消解):谁能覆盖谁,由 source_priority 决定,不是「谁最后写谁赢」
 *   2. 重算档案:完整度 / 缺失项 / curated_snapshot(注入 prompt 的那一份)
 *   3. 给 agent 读:agent → squad → douyin_account → profile 的解析链
 */
export function accountProfileService(db: Db) {
  /**
   * 写入一批事实,带冲突消解。
   *
   * 规则(0148 表注释里定的,这里兑现):
   *   - 每个 field_key 同一时刻只有一条 active 事实(partial unique index 在库层兜底)
   *   - 新事实的 source_priority **严格低于**现有 active 事实时:拒绝写入,现状不动
   *   - 优先级 >= 现有时:现有那条置为 superseded 并指向新条(supersededById),新条 active
   *
   * 为什么是 >= 而不是 >:同来源的**重新同步**必须能刷新自己的值(TikHub 今天粉丝数变了),
   * 否则第二次同步永远写不进去。跨来源的覆盖仍然要求更高优先级。
   *
   * 为什么保留被覆盖的那条而不是删掉:证据链。以后用户问「凭什么说我是离婚律师」,
   * 要能答出「模型从你 12 条作品推的,后来你自己改成了股权律师」。删了就永远答不出来。
   */
  async function writeFacts(
    profileId: string,
    facts: readonly FactInput[],
  ): Promise<{ results: FactWriteResult[]; appliedCount: number }> {
    if (facts.length === 0) return { results: [], appliedCount: 0 };

    const profile = await getProfileRow(profileId);
    const specKeys = new Set(getProfileFieldSpec(profile.specVersion).map((f) => f.key));

    const results: FactWriteResult[] = [];

    // 一个事务:要么这批事实连同 supersede 一起生效,要么全不生效。
    // 半写状态会留下「两条 active」——库层的 partial unique index 会直接拒绝,
    // 但那时报出来的是约束冲突,而不是业务原因,排查成本高得多。
    await db.transaction(async (tx) => {
      const keys = facts.map((f) => f.fieldKey);
      const existing = await tx
        .select({
          id: accountProfileFacts.id,
          fieldKey: accountProfileFacts.fieldKey,
          sourcePriority: accountProfileFacts.sourcePriority,
        })
        .from(accountProfileFacts)
        .where(
          and(
            eq(accountProfileFacts.profileId, profileId),
            eq(accountProfileFacts.status, "active"),
            inArray(accountProfileFacts.fieldKey, keys),
          ),
        );
      const existingByKey = new Map(existing.map((row) => [row.fieldKey, row]));

      for (const fact of facts) {
        if (!specKeys.has(fact.fieldKey)) {
          // 规格外的 key 直接拒 —— 否则拼错的字段名会静静躺在库里,完整度永远算不到它
          results.push({ fieldKey: fact.fieldKey, applied: false, reason: "unknown_field" });
          continue;
        }
        if (!isProfileValueFilled(fact.value)) {
          // 空值不写。「同步跑过但没拉到」不该在库里留下一条空事实把完整度刷上去
          results.push({ fieldKey: fact.fieldKey, applied: false, reason: "empty_value" });
          continue;
        }

        const priority = PROFILE_SOURCE_PRIORITY[fact.source];
        const current = existingByKey.get(fact.fieldKey);

        if (current && priority < current.sourcePriority) {
          results.push({ fieldKey: fact.fieldKey, applied: false, reason: "lower_priority" });
          continue;
        }

        // ⚠️ 顺序是硬约束,不能调换:必须**先退旧的,再插新的**。
        // account_profile_facts 上有 partial unique index (profile_id, field_key) WHERE status='active',
        // Postgres 的唯一索引是**每条语句结束时**检查的(非 deferrable),
        // 所以「先 insert 新 active 再 update 旧的」会在 insert 那一刻就出现两条 active → 直接违约报错。
        if (current) {
          await tx
            .update(accountProfileFacts)
            .set({ status: "superseded", supersededAt: new Date(), updatedAt: new Date() })
            .where(eq(accountProfileFacts.id, current.id));
        }

        const [inserted] = await tx
          .insert(accountProfileFacts)
          .values({
            companyId: profile.companyId,
            profileId,
            fieldKey: fact.fieldKey,
            value: fact.value as never,
            source: fact.source,
            sourcePriority: priority,
            confidence: fact.confidence ?? 100,
            evidenceRef: fact.evidenceRef ?? null,
            status: "active",
            createdByAgentId: fact.createdByAgentId ?? null,
            createdByUserId: fact.createdByUserId ?? null,
          })
          .returning({ id: accountProfileFacts.id });

        // 证据链的最后一环:旧事实指向取代它的那条,「凭什么覆盖」以后能一路回溯
        if (current) {
          await tx
            .update(accountProfileFacts)
            .set({ supersededById: inserted.id })
            .where(eq(accountProfileFacts.id, current.id));
        }

        results.push({ fieldKey: fact.fieldKey, applied: true });
        existingByKey.set(fact.fieldKey, { id: inserted.id, fieldKey: fact.fieldKey, sourcePriority: priority });
      }
    });

    const appliedCount = results.filter((r) => r.applied).length;
    return { results, appliedCount };
  }

  async function getProfileRow(profileId: string) {
    const [row] = await db.select().from(accountProfiles).where(eq(accountProfiles.id, profileId)).limit(1);
    if (!row) throw notFound(`Account profile ${profileId} not found`);
    return row;
  }

  /**
   * 取一个档案当前所有生效事实,聚合成 { fieldKey: value }。
   * 一条查询,不是每个字段查一次。
   */
  async function getActiveFactValues(profileId: string): Promise<Record<string, unknown>> {
    const rows = await db
      .select({
        fieldKey: accountProfileFacts.fieldKey,
        value: accountProfileFacts.value,
        source: accountProfileFacts.source,
        confidence: accountProfileFacts.confidence,
      })
      .from(accountProfileFacts)
      .where(and(eq(accountProfileFacts.profileId, profileId), eq(accountProfileFacts.status, "active")));

    const values: Record<string, unknown> = {};
    for (const row of rows) values[row.fieldKey] = row.value;
    return values;
  }

  /**
   * 重算档案:完整度 / 缺失项 / curated_snapshot。
   *
   * curated_snapshot 是「注入 prompt 的那一份」(0148 表注释)。agent 一次读取即可拿到全部档案,
   * 不必扫 facts 表再自己聚合 —— 这也是 prompt caching 的天然断点(JIN-51 实测命中省 94% input),
   * 所以它必须**稳定**:字段顺序固定(按规格顺序,不是 Object.keys 的插入顺序),
   * 否则同样的内容因为键序抖动就会 cache miss,94% 的省钱直接蒸发。
   *
   * revision 每次重算 +1,给缓存失效用。
   */
  async function recompute(profileId: string, curatedByAgentId?: string | null) {
    const profile = await getProfileRow(profileId);
    const values = await getActiveFactValues(profileId);
    const spec = getProfileFieldSpec(profile.specVersion);
    const completeness = computeProfileCompleteness(values, profile.specVersion);

    const [account] = await db
      .select()
      .from(douyinAccounts)
      .where(eq(douyinAccounts.id, profile.douyinAccountId))
      .limit(1);

    // 按规格顺序构建,保证键序稳定 → prompt cache 命中率稳定
    const fields: Record<string, unknown> = {};
    for (const field of spec) {
      if (isProfileValueFilled(values[field.key])) fields[field.key] = values[field.key];
    }

    const snapshot = {
      specVersion: profile.specVersion,
      account: account
        ? {
            nickname: account.nickname,
            uniqueId: account.uniqueId,
            signature: account.signature,
            followerCount: account.followerCount,
            awemeCount: account.awemeCount,
          }
        : null,
      fields,
      completenessPct: completeness.completenessPct,
      missingFields: completeness.missingFields,
    };

    const [updated] = await db
      .update(accountProfiles)
      .set({
        positioning: asString(values.positioning),
        targetAudience: asString(values.target_audience),
        tonePreferences: asStringArray(values.tone_preferences),
        bannedExpressions: asStringArray(values.banned_expressions),
        effectiveMethods: asObjectArray(values.effective_methods),
        curatedSnapshot: snapshot,
        completenessPct: completeness.completenessPct,
        missingFields: [...completeness.missingFields],
        revision: sql`${accountProfiles.revision} + 1`,
        lastCuratedByAgentId: curatedByAgentId ?? null,
        lastCuratedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(accountProfiles.id, profileId))
      .returning();

    return { profile: updated, completeness, snapshot };
  }

  /**
   * 「缺失信息引导补全」+「不会填,帮我诊断一下」的数据面。
   * 返回每个缺失字段该问什么、能不能靠同步自动补、不能的话诊断策略是什么。
   */
  async function getGuidance(profileId: string) {
    const profile = await getProfileRow(profileId);
    const values = await getActiveFactValues(profileId);
    const completeness = computeProfileCompleteness(values, profile.specVersion);
    const guidance = buildProfileGuidance(completeness.missingFields, profile.specVersion);

    return {
      profileId,
      completenessPct: completeness.completenessPct,
      missingRequiredFields: completeness.missingRequiredFields,
      // 能靠「重新同步全部来源」补掉的 vs 只能问用户的 —— UI 分两栏靠这个
      autoFillable: guidance.filter((g) => g.canAutoFill),
      needsUser: guidance.filter((g) => !g.canAutoFill),
    };
  }

  /**
   * agent 读档案。解析链:agent → squad_members → squads.douyin_account_id → account_profiles。
   *
   * squads.douyin_account_id 可空(0148),所以「这个 agent 没绑账号」是**正常态**,不是错误 ——
   * 返回 null 让调用方决定怎么办(招聘完还没绑号的 agent 就是这个状态)。
   */
  async function getSnapshotForAgent(companyId: string, agentId: string) {
    const rows = await db
      .select({
        profileId: accountProfiles.id,
        curatedSnapshot: accountProfiles.curatedSnapshot,
        completenessPct: accountProfiles.completenessPct,
        missingFields: accountProfiles.missingFields,
        revision: accountProfiles.revision,
        douyinAccountId: accountProfiles.douyinAccountId,
      })
      .from(squadMembers)
      .innerJoin(squads, eq(squadMembers.squadId, squads.id))
      .innerJoin(accountProfiles, eq(accountProfiles.douyinAccountId, squads.douyinAccountId))
      .where(
        and(
          eq(squadMembers.companyId, companyId),
          eq(squadMembers.memberType, "agent"),
          eq(squadMembers.agentId, agentId),
          eq(squads.status, "active"),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async function getByDouyinAccount(companyId: string, douyinAccountId: string) {
    const [row] = await db
      .select()
      .from(accountProfiles)
      .where(and(eq(accountProfiles.companyId, companyId), eq(accountProfiles.douyinAccountId, douyinAccountId)))
      .limit(1);
    return row ?? null;
  }

  /** 档案是 1:1 于抖音账号的(0148 的 unique index),所以 ensure 是幂等的 */
  async function ensureForDouyinAccount(companyId: string, douyinAccountId: string) {
    const existing = await getByDouyinAccount(companyId, douyinAccountId);
    if (existing) return existing;

    const [created] = await db
      .insert(accountProfiles)
      .values({
        companyId,
        douyinAccountId,
        specVersion: PROFILE_SPEC_VERSION_V1,
      })
      .onConflictDoNothing({ target: accountProfiles.douyinAccountId })
      .returning();

    // onConflictDoNothing 返回空 = 并发下别人先建了,再读一次
    if (created) return created;
    const raced = await getByDouyinAccount(companyId, douyinAccountId);
    if (!raced) throw unprocessable("Failed to create account profile");
    return raced;
  }

  async function listSyncSources(profileId: string) {
    return db
      .select()
      .from(profileSyncSources)
      .where(eq(profileSyncSources.profileId, profileId));
  }

  return {
    writeFacts,
    getActiveFactValues,
    recompute,
    getGuidance,
    getSnapshotForAgent,
    getByDouyinAccount,
    ensureForDouyinAccount,
    listSyncSources,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}
