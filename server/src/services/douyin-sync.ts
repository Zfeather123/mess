import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { douyinAccounts, douyinVideos, douyinVideoMetrics, profileSyncSources } from "@paperclipai/db";
import type { DouyinUserProfile, DouyinVideo, TikHubClient } from "@jin/tikhub";
import { TikHubError } from "@jin/tikhub";
import { accountProfileService, type FactInput } from "./account-profiles.js";

export interface SyncOptions {
  /** 拉多少页作品(每页 ≤20)。默认 3 页 ≈ 60 条,够算「有效方法」了,再多是花钱买边际递减 */
  readonly maxVideoPages?: number;
  /** 是否补拉播放量。默认 true,但它很贵:一次最多 2 个 aweme_id(见 TIKHUB_CAPABILITIES.md §4.1) */
  readonly fetchPlayCounts?: boolean;
  /** 只补播放量给最近 N 条 —— 全量补的调用次数 = N/2,60 条就是 30 次调用 */
  readonly playCountLimit?: number;
}

export interface SyncResult {
  readonly douyinAccountId: string;
  readonly profileId: string;
  readonly videosSynced: number;
  readonly playCountsFetched: number;
  readonly factsWritten: number;
  readonly completenessPct: number;
  readonly missingFields: readonly string[];
}

/**
 * TikHub 同步:一个抖音链接 → 预填好的账号档案。
 *
 * 这是产品的第一次「Aha」:律师粘一条分享链接,回来就看到一份填了一半的档案 +
 * 一句「还差这几项,要我诊断一下吗」。所以这条链路的**失败必须是局部的** ——
 * 拉不到作品不该让已经拿到的账号资料一起丢掉。每一步的产出都立即落库。
 */
export function douyinSyncService(db: Db, tikhub: TikHubClient) {
  const profiles = accountProfileService(db);

  /**
   * 从链接同步。input 可以是分享短链、整段分享口令文案、长链,或直接 sec_uid ——
   * 律师从抖音 App 复制出来的就是那一大坨带表情的口令文案,直接吞下去,不要求用户清洗。
   */
  async function syncFromLink(companyId: string, input: string, opts: SyncOptions = {}): Promise<SyncResult> {
    const secUid = await tikhub.resolveSecUid(input);
    const remote = await tikhub.fetchUserProfile(secUid);

    const account = await upsertAccount(companyId, remote);
    const profile = await profiles.ensureForDouyinAccount(companyId, account.id);

    await markSyncing(companyId, profile.id, "tikhub");

    try {
      const result = await syncAccountData(companyId, account.id, profile.id, secUid, remote, opts);
      await markSynced(profile.id, "tikhub", result.factsWritten);
      return result;
    } catch (error) {
      await markError(profile.id, "tikhub", error);
      throw error;
    }
  }

  async function syncAccountData(
    companyId: string,
    douyinAccountId: string,
    profileId: string,
    secUid: string,
    remote: DouyinUserProfile,
    opts: SyncOptions,
  ): Promise<SyncResult> {
    const maxPages = opts.maxVideoPages ?? 3;
    const wantPlayCounts = opts.fetchPlayCounts ?? true;
    const playCountLimit = opts.playCountLimit ?? 20;

    // --- 作品 ---
    // 作品拉失败不该让账号资料白同步:上面 upsertAccount 已经落库了,这里失败只是少了作品维度。
    let videos: DouyinVideo[] = [];
    try {
      videos = await tikhub.fetchUserVideos(secUid, { maxPages });
    } catch (error) {
      if (!(error instanceof TikHubError) || !isPartialFailureTolerable(error)) throw error;
      videos = [];
    }

    let playCountsFetched = 0;
    if (wantPlayCounts && videos.length > 0) {
      // ⚠️ 播放量只能从专用统计接口拿(一次最多 2 个 aweme_id),列表里的 play_count 不可信。
      // 只补最近 playCountLimit 条:全量补 = N/2 次调用,60 条作品就是 30 次,钱烧在边际价值最低的老作品上。
      const recent = videos.slice(0, playCountLimit);
      try {
        const stats = await tikhub.fetchVideoStatistics(recent.map((v) => v.awemeId));
        for (const video of recent) {
          const fetched = stats.get(video.awemeId);
          if (!fetched) continue;
          // 统计接口不返回 comment/collect,与列表里的合并 —— 各取各自可信的那部分
          video.stats = {
            ...video.stats,
            playCount: fetched.playCount,
            playCountSource: fetched.playCountSource,
            diggCount: fetched.diggCount || video.stats.diggCount,
            shareCount: fetched.shareCount || video.stats.shareCount,
          };
          playCountsFetched += 1;
        }
      } catch (error) {
        // 播放量补不到 = playCount 保持 null(「没拉到」),不是 0(「扑街」)。降级,不失败。
        if (!(error instanceof TikHubError) || !isPartialFailureTolerable(error)) throw error;
      }
    }

    const videoRows = await upsertVideos(companyId, douyinAccountId, videos);

    // --- 事实 ---
    const facts = deriveFacts(remote, videos);
    const { appliedCount } = await profiles.writeFacts(profileId, facts);

    const { completeness } = await profiles.recompute(profileId);

    return {
      douyinAccountId,
      profileId,
      videosSynced: videoRows,
      playCountsFetched,
      factsWritten: appliedCount,
      completenessPct: completeness.completenessPct,
      missingFields: completeness.missingFields,
    };
  }

  async function upsertAccount(companyId: string, remote: DouyinUserProfile) {
    const [existing] = await db
      .select()
      .from(douyinAccounts)
      .where(and(eq(douyinAccounts.companyId, companyId), eq(douyinAccounts.secUid, remote.secUid)))
      .limit(1);

    const values = {
      companyId,
      secUid: remote.secUid,
      douyinUid: remote.uid ?? null,
      uniqueId: remote.uniqueId ?? null,
      nickname: remote.nickname,
      avatarUrl: remote.avatarUrl ?? null,
      signature: remote.signature ?? null,
      followerCount: remote.followerCount,
      followingCount: remote.followingCount,
      awemeCount: remote.awemeCount,
      totalFavorited: remote.totalFavorited,
      tikhubSyncedAt: new Date(),
      tikhubSyncError: null,
      rawProfile: remote.raw,
      updatedAt: new Date(),
    };

    if (existing) {
      const [updated] = await db
        .update(douyinAccounts)
        .set(values)
        .where(eq(douyinAccounts.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await db.insert(douyinAccounts).values(values).returning();
    return created;
  }

  /**
   * 作品 upsert + 指标追加。
   *
   * 指标是**时序表**:每次同步追加一行,不覆盖。所以「同一秒重放同步」会撞 unique(video_id, captured_at) ——
   * 用 onConflictDoNothing 吞掉,重放同步是幂等的,不会写出两行一模一样的指标。
   */
  async function upsertVideos(companyId: string, douyinAccountId: string, videos: readonly DouyinVideo[]) {
    if (videos.length === 0) return 0;

    const capturedAt = new Date();
    let count = 0;

    for (const video of videos) {
      const [row] = await db
        .insert(douyinVideos)
        .values({
          companyId,
          douyinAccountId,
          awemeId: video.awemeId,
          description: video.description ?? null,
          publishedAt: video.createTime ? new Date(video.createTime * 1000) : null,
          durationMs: video.durationMs ?? null,
          coverUrl: video.coverUrl ?? null,
          shareUrl: video.shareUrl ?? null,
          hashtags: video.hashtags,
          tikhubSyncedAt: capturedAt,
          rawAweme: video.raw,
          updatedAt: capturedAt,
        })
        .onConflictDoUpdate({
          target: [douyinVideos.companyId, douyinVideos.awemeId],
          set: {
            description: video.description ?? null,
            hashtags: video.hashtags,
            tikhubSyncedAt: capturedAt,
            rawAweme: video.raw,
            updatedAt: capturedAt,
          },
        })
        .returning({ id: douyinVideos.id });

      if (!row) continue;

      await db
        .insert(douyinVideoMetrics)
        .values({
          companyId,
          videoId: row.id,
          capturedAt,
          playCount: video.stats.playCount,
          playCountSource: video.stats.playCountSource,
          diggCount: video.stats.diggCount,
          commentCount: video.stats.commentCount,
          shareCount: video.stats.shareCount,
          collectCount: video.stats.collectCount,
        })
        .onConflictDoNothing({ target: [douyinVideoMetrics.videoId, douyinVideoMetrics.capturedAt] });

      count += 1;
    }

    return count;
  }

  return { syncFromLink, upsertVideos, listSyncSources: profiles.listSyncSources };

  // ---- 同步状态(原型第 7 张图:每个来源显示同步状态和时间)----

  async function markSyncing(companyId: string, profileId: string, source: string) {
    await db
      .insert(profileSyncSources)
      .values({ companyId, profileId, source, status: "syncing", lastAttemptAt: new Date(), attemptCount: 1 })
      .onConflictDoUpdate({
        target: [profileSyncSources.profileId, profileSyncSources.source],
        set: {
          status: "syncing",
          lastAttemptAt: new Date(),
          // 自增而不是覆盖:重试次数是累计的,「这个来源连着失败了 5 次」才是有用的信号
          attemptCount: sql`${profileSyncSources.attemptCount} + 1`,
          updatedAt: new Date(),
        },
      });
  }

  async function markSynced(profileId: string, source: string, factsWritten: number) {
    await db
      .update(profileSyncSources)
      .set({
        status: "synced",
        lastSyncedAt: new Date(),
        lastErrorCode: null,
        lastErrorMessage: null,
        factsWritten,
        updatedAt: new Date(),
      })
      .where(and(eq(profileSyncSources.profileId, profileId), eq(profileSyncSources.source, source)));
  }

  async function markError(profileId: string, source: string, error: unknown) {
    const code: string = error instanceof TikHubError ? error.code : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(profileSyncSources)
      .set({
        status: "error",
        lastErrorCode: code,
        // 错误信息可能带 token/URL,截断并且不落原始响应体
        lastErrorMessage: message.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(and(eq(profileSyncSources.profileId, profileId), eq(profileSyncSources.source, source)));
  }
}

/** 局部失败可容忍:账号私密、没作品、限流 —— 已经拿到的账号资料要留住,不能整单回滚 */
function isPartialFailureTolerable(error: TikHubError): boolean {
  return error.code === "private_account" || error.code === "not_found" || error.code === "rate_limited";
}

/**
 * 从 TikHub 数据推导档案事实。
 *
 * ⚠️ 这里**刻意只推导有直接证据的字段**。positioning / target_audience 需要语义理解,
 * 必须由「账号诊断师」调模型来做(用户点「不会填,帮我诊断一下」时),
 * 在这里用规则硬猜出来是最糟的选择:它会以 tikhub(优先级 60)的身份写进库,
 * 把后续模型推断(10)和用户手填之外的一切都挡在门外,而且用户根本不知道这个「定位」是猜的。
 *
 * 每条事实都带 evidence_ref —— 「凭什么说我在杭州」要能回答。
 */
export function deriveFacts(remote: DouyinUserProfile, videos: readonly DouyinVideo[]): FactInput[] {
  const facts: FactInput[] = [];

  // 执业城市 ← IP 属地。弱信号:用户可能在外地刷手机,所以 confidence 只给 50。
  if (remote.ipLocation) {
    facts.push({
      fieldKey: "city",
      value: normalizeCity(remote.ipLocation),
      source: "tikhub",
      confidence: 50,
      evidenceRef: { field: "ip_location", raw: remote.ipLocation },
    });
  }

  // 所属律所 ← custom_verify(个人认证)。这是抖音**认证过**的字段,常年就是「XX律所律师」,
  // 可信度远高于签名里的自述 → confidence 90。
  const firm = extractLawFirm(remote.customVerify) ?? extractLawFirm(remote.enterpriseVerifyReason);
  if (firm) {
    facts.push({
      fieldKey: "law_firm",
      value: firm,
      source: "tikhub",
      confidence: 90,
      evidenceRef: { field: "custom_verify", raw: remote.customVerify ?? remote.enterpriseVerifyReason },
    });
  }

  // 业务领域 ← 作品 hashtags 词频 Top3。这是从历史内容里统计出来的,不是 TikHub 直接给的,
  // 所以 source 是 history_content(优先级 40)而不是 tikhub(60)—— 来源标签要诚实,
  // 否则以后没人搞得清这个值到底是抖音给的还是我们算的。
  const areas = topHashtags(videos, 3);
  if (areas.length > 0) {
    facts.push({
      fieldKey: "practice_areas",
      value: areas,
      source: "history_content",
      confidence: 60,
      evidenceRef: { derivedFrom: "video_hashtags", sampleSize: videos.length },
    });
  }

  return facts;
}

function normalizeCity(ipLocation: string): string {
  // TikHub 的 ip_location 形如 "IP属地:浙江" 或 "浙江"
  return ipLocation.replace(/^IP属地[:：]?/, "").trim();
}

function extractLawFirm(verify: string | undefined): string | null {
  if (!verify) return null;
  // 「XX律师事务所律师」/「XX律所合伙人」→ 取到「律师事务所」/「律所」为止
  const match = verify.match(/^(.*?(?:律师事务所|律所))/);
  if (match?.[1]) return match[1].trim();
  return null;
}

function topHashtags(videos: readonly DouyinVideo[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const video of videos) {
    for (const tag of video.hashtags) {
      const clean = tag.trim();
      if (!clean) continue;
      counts.set(clean, (counts.get(clean) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag);
}
