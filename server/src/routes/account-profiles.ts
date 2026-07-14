import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createTikHubClient, TikHubError, type TikHubClient } from "@jin/tikhub";
import { validate } from "../middleware/validate.js";
import { accountProfileService, douyinSyncService } from "../services/index.js";
import {
  toAccountProfileDto,
  toDouyinSyncResultDto,
  toProfileFactWriteResultDto,
  toProfileGuidanceDto,
  toProfileSyncSourceDto,
} from "../dto/jin54.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/**
 * ⚠️ 注意这里**没有** `body:` 包一层。
 *
 * `validate()` 干的是 `req.body = schema.parse(req.body)` —— 它把 schema 直接套在 req.body 上。
 * 之前这两个 schema 各自包了一层 `body:`,于是 parse 的是 `req.body.body`(永远 undefined),
 * **两个 POST 接口在线上恒返回 400**,而且没有任何测试覆盖到 —— 直到契约测试真的发了一次请求。
 * 全仓库的既定写法就是平铺的(见 validators/approval.ts)。
 */
const syncFromLinkSchema = z.object({
  /** 分享短链 / 整段分享口令文案 / 长链 / sec_uid —— 律师复制什么就粘什么,不要求清洗 */
  link: z.string().min(1).max(2000),
  maxVideoPages: z.number().int().min(1).max(10).optional(),
  fetchPlayCounts: z.boolean().optional(),
});

/** 用户手填事实。source 固定为 user(优先级 100)—— 不允许调用方自称是 tikhub 来抢优先级 */
const writeFactsSchema = z.object({
  facts: z
    .array(
      z.object({
        fieldKey: z.string().min(1).max(100),
        value: z.unknown(),
        confidence: z.number().int().min(0).max(100).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export function accountProfileRoutes(db: Db, options: { tikhub?: TikHubClient } = {}) {
  const router = Router();
  const profiles = accountProfileService(db);

  // TikHub 客户端是懒构造的:loadTikhubConfig() 在缺 TIKHUB_API_KEY 时会抛错,
  // 而绝大多数请求根本不碰 TikHub —— 没配 key 不该让整个 server 起不来,
  // 只该让「同步」这一个接口返回 503。
  let tikhubClient: TikHubClient | null = options.tikhub ?? null;
  function getTikhub(): TikHubClient {
    if (!tikhubClient) tikhubClient = createTikHubClient();
    return tikhubClient;
  }

  /**
   * 一条抖音链接 → 预填好的账号档案。
   * 这是产品的第一次 Aha,也是本 issue 的核心验收项。
   */
  router.post(
    "/companies/:companyId/douyin-accounts/sync",
    validate(syncFromLinkSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      let sync;
      try {
        sync = douyinSyncService(db, getTikhub());
      } catch {
        // 没配 TIKHUB_API_KEY —— 这是配置缺失,不是用户错误,如实说
        res.status(503).json({ error: "TikHub is not configured (TIKHUB_API_KEY missing)" });
        return;
      }

      try {
        const result = await sync.syncFromLink(companyId, req.body.link, {
          maxVideoPages: req.body.maxVideoPages,
          fetchPlayCounts: req.body.fetchPlayCounts,
        });
        res.json(toDouyinSyncResultDto(result));
      } catch (error) {
        if (error instanceof TikHubError) {
          res.status(tikhubHttpStatus(error)).json({ error: error.message, code: error.code });
          return;
        }
        throw error;
      }
    },
  );

  /** 档案详情 + 完整度 + 缺失项 */
  router.get("/companies/:companyId/douyin-accounts/:douyinAccountId/profile", async (req, res) => {
    const companyId = req.params.companyId as string;
    const douyinAccountId = req.params.douyinAccountId as string;
    assertCompanyAccess(req, companyId);

    const profile = await profiles.getByDouyinAccount(companyId, douyinAccountId);
    if (!profile) {
      res.status(404).json({ error: "Account profile not found" });
      return;
    }

    const [syncSources, guidance] = await Promise.all([
      profiles.listSyncSources(profile.id),
      profiles.getGuidance(profile.id),
    ]);

    res.json({
      profile: toAccountProfileDto(profile),
      syncSources: syncSources.map(toProfileSyncSourceDto),
      guidance: toProfileGuidanceDto(guidance),
    });
  });

  /**
   * 「缺失信息引导补全」/「不会填,帮我诊断一下」的数据面。
   * autoFillable = 重新同步就能补掉;needsUser = 无论如何都得问用户(如 禁用表达)。
   */
  router.get("/profiles/:profileId/guidance", async (req, res) => {
    const guidance = await profiles.getGuidance(req.params.profileId as string);
    res.json(toProfileGuidanceDto(guidance));
  });

  /** 用户手填(source=user,优先级最高,压过一切同步与推断) */
  router.post("/profiles/:profileId/facts", validate(writeFactsSchema), async (req, res) => {
    const actor = getActorInfo(req);
    const profileId = req.params.profileId as string;
    const result = await profiles.writeFacts(
      profileId,
      req.body.facts.map((fact: { fieldKey: string; value: unknown; confidence?: number }) => ({
        ...fact,
        source: "user" as const,
        // agent 代填也记在它自己头上,但 source 仍是 user —— 「谁写的」和「算哪种来源」是两件事
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        createdByAgentId: actor.agentId,
      })),
    );
    const { profile, completeness } = await profiles.recompute(profileId);
    res.json({
      results: result.results.map(toProfileFactWriteResultDto),
      appliedCount: result.appliedCount,
      profile: toAccountProfileDto(profile),
      completenessPct: completeness.completenessPct,
      missingFields: [...completeness.missingFields],
    });
  });

  /** 每个来源的同步状态与时间(原型:「重新同步全部来源」下的状态行) */
  router.get("/profiles/:profileId/sync-sources", async (req, res) => {
    const sources = await profiles.listSyncSources(req.params.profileId as string);
    res.json(sources.map(toProfileSyncSourceDto));
  });

  /**
   * AI 员工读档案的工具端点。
   *
   * xiaojing-executor 的 RemoteExecutor 把所有 cloud.* 工具 POST 到 `${serverBaseUrl}/api/tools/<name>`,
   * 所以 read_account_profile 落在这里。返回 { text } —— RemoteExecutor 就读这个字段。
   *
   * ⚠️ 安全边界:**不信任 body.agentId**。档案归属完全由已认证的 actor 推导
   * (agent → squad → douyin_account → profile)。如果这里认 body 里的 agentId,
   * 任何一个 agent 只要改个 ID 就能读到别的小队的档案 —— 而 agent 的输入是模型生成的,
   * 等于把越权读取的开关交给了模型。
   */
  router.post("/tools/read_account_profile", async (req, res) => {
    const actor = getActorInfo(req);
    if (actor.actorType !== "agent" || !actor.agentId) {
      res.status(403).json({ error: "read_account_profile is an agent-only tool" });
      return;
    }
    const companyId = req.actor?.type === "agent" ? req.actor.companyId : undefined;
    if (!companyId) {
      res.status(403).json({ error: "Agent actor has no company scope" });
      return;
    }

    const row = await profiles.getSnapshotForAgent(companyId, actor.agentId);
    if (!row) {
      // 「这个 agent 还没绑账号」是正常态(刚招聘进来的员工),不是错误 —— 如实说,别编一份空档案
      res.json({
        text: "当前没有绑定的账号档案(这个 AI 员工还没有加入任何绑定了抖音账号的小队)。请先在小队里绑定抖音账号并同步档案。",
      });
      return;
    }

    res.json({
      text: buildProfilePromptBlock(row.curatedSnapshot as Record<string, unknown>),
      profileId: row.profileId,
      revision: row.revision,
      completenessPct: row.completenessPct,
    });
  });

  return router;
}

/**
 * 把 curated_snapshot 渲染成给模型看的一段文本。
 *
 * 这段文本有两个消费方:
 *   1. read_account_profile 工具的返回(模型主动拉)
 *   2. **系统提示词的静态段**(每轮都带,模型不用记得去拉)
 *
 * 两个都要,不是二选一:工具是 pull,模型可能忘了调;静态注入是 push,保证「所有 AI 员工
 * 生成内容时都读得到」这条产品硬要求。
 *
 * ⚠️ 注入位置:必须放在 buildSystemPrompt 的 **staticParts**(cache 断点之前)。
 * 档案是「共享且很少变」的内容,放 dynamicParts 会让它每轮重新计费 ——
 * JIN-51 实测 prompt caching 命中省 94% input,放错边这 94% 直接蒸发。
 * 缓存失效用 profile.revision 做 key(每次 recompute 自增)。
 */
export function buildProfilePromptBlock(snapshot: Record<string, unknown>): string {
  const fields = (snapshot.fields ?? {}) as Record<string, unknown>;
  const account = snapshot.account as { nickname?: string; followerCount?: number } | null;
  const missing = (snapshot.missingFields ?? []) as string[];

  const lines: string[] = ["# 账号档案(全体 AI 员工的共享上下文)"];

  if (account?.nickname) {
    lines.push(`- 账号:${account.nickname}(粉丝 ${account.followerCount ?? 0})`);
  }

  const render = (key: string, label: string) => {
    const value = fields[key];
    if (value === undefined || value === null) return;
    const text = Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("、") : String(value);
    if (text.trim()) lines.push(`- ${label}:${text}`);
  };

  render("positioning", "账号定位");
  render("target_audience", "目标客户");
  render("practice_areas", "业务领域");
  render("tone_preferences", "表达偏好");
  render("banned_expressions", "⛔ 禁用表达(合规硬红线,任何情况下都不得出现)");
  render("effective_methods", "已验证的有效方法");
  render("city", "执业城市");
  render("law_firm", "所属律所");
  render("years_of_practice", "执业年限");

  lines.push(`- 档案完整度:${snapshot.completenessPct ?? 0}%`);
  if (missing.length > 0) {
    // 让模型知道**哪里是空的**,它才不会自己编。缺定位就该问,不是瞎猜一个。
    lines.push(`- ⚠️ 尚缺失(不要臆造这些信息,需要时向用户确认):${missing.join("、")}`);
  }

  return lines.join("\n");
}

function tikhubHttpStatus(error: TikHubError): number {
  switch (error.code) {
    case "unauthorized":
      return 502; // 是**我们的** TikHub key 无效,不是调用方没权限 —— 不能回 401 误导用户去重新登录
    case "insufficient_balance":
      return 402;
    case "rate_limited":
      return 429;
    case "not_found":
    case "private_account":
      return 404;
    case "invalid_input":
      return 400;
    default:
      return 502;
  }
}
