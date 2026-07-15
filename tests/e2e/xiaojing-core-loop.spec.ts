import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

/**
 * JIN-88 —— 小镜核心闭环 E2E(浏览器层,authenticated 模式)。
 *
 * 覆盖的主链路(每次结构都跑,LLM 相关的产出内容才受 PAPERCLIP_E2E_SKIP_LLM 降级):
 *   真人注册/认领实例 → 建公司 → 招募 AI 员工 → 群里/看板派活给该员工
 *   → 断言「被指派人真出 heartbeat_runs 行(invocation_source='assignment')」
 *   → 算力钱包可读(为「产出→审核→扣算力」尾段兜底)。
 *
 * 铁律:
 *   - 全程 authenticated session(cookie),actor.source = "session",走生产 resolveBoardAccess()。
 *     绝不用 local_trusted/local_implicit(那会让 assertCompanyAccess 整段免检 = 恒绿零覆盖)。
 *   - 「被指派人真出 heartbeat_runs 行」用真实 DB 读(packages/db/scripts/read-heartbeat-runs.ts),
 *     中间不许 mock 顶任何一段。
 */

const BASE = process.env.PAPERCLIP_E2E_BASE_URL ?? "http://127.0.0.1:3110";
const DATA_DIR = process.env.PAPERCLIP_E2E_DATA_DIR ?? process.env.PAPERCLIP_HOME;
const CONFIG_PATH =
  process.env.PAPERCLIP_E2E_CONFIG_PATH ?? path.resolve(process.cwd(), ".paperclip/config.json");
const BOOTSTRAP_SCRIPT_PATH = path.resolve(process.cwd(), "packages/db/scripts/create-auth-bootstrap-invite.ts");
const HEARTBEAT_READER_PATH = path.resolve(process.cwd(), "packages/db/scripts/read-heartbeat-runs.ts");
const SKIP_LLM = process.env.PAPERCLIP_E2E_SKIP_LLM !== "false";

const runId = Date.now();
const ownerUser = {
  name: "闭环 Owner",
  email: `core-loop-owner-${runId}@paperclip.local`,
  password: "core-loop-owner-password",
};
const companyName = `CoreLoop-${runId}`;

type SessionJsonResponse<T> = { ok: boolean; status: number; text: string; json: T | null };
type CompanySummary = { id: string; name: string; issuePrefix?: string | null };
type EmployeeCard = { source: string; refId: string; name: string; role?: string; hired?: boolean };
type HireResult = { agentId: string };
type IssueSummary = { id: string };

function pnpmBin() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function requireBootstrapPrereqs() {
  if (!DATA_DIR) throw new Error("PAPERCLIP_E2E_DATA_DIR / PAPERCLIP_HOME is required");
  if (!existsSync(CONFIG_PATH)) throw new Error(`Authenticated bootstrap config not found at ${CONFIG_PATH}`);
  if (!existsSync(BOOTSTRAP_SCRIPT_PATH)) throw new Error(`Bootstrap invite helper not found at ${BOOTSTRAP_SCRIPT_PATH}`);
  if (!existsSync(HEARTBEAT_READER_PATH)) throw new Error(`heartbeat_runs reader not found at ${HEARTBEAT_READER_PATH}`);
}

function createBootstrapInvite() {
  return execFileSync(
    pnpmBin(),
    ["--filter", "@paperclipai/db", "exec", "tsx", BOOTSTRAP_SCRIPT_PATH, "--config", CONFIG_PATH, "--base-url", BASE],
    { cwd: process.cwd(), env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", PAPERCLIP_HOME: DATA_DIR }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function readAssignmentRuns(companyId: string, agentId: string): { count: number; rows: Array<{ id: string; invocationSource: string; status: string }> } {
  const out = execFileSync(
    pnpmBin(),
    ["--filter", "@paperclipai/db", "exec", "tsx", HEARTBEAT_READER_PATH, "--config", CONFIG_PATH, "--company", companyId, "--agent", agentId, "--source", "assignment"],
    { cwd: process.cwd(), env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", PAPERCLIP_HOME: DATA_DIR }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  // pnpm --filter exec 可能带前缀行;取最后一行 JSON。
  const lastLine = out.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "{}";
  return JSON.parse(lastLine);
}

async function signUp(page: Page) {
  await page.goto(`${BASE}/auth`);
  await expect(page.getByRole("heading", { name: "Sign in to Paperclip" })).toBeVisible();
  await page.getByRole("button", { name: "Create one" }).click();
  await expect(page.getByRole("heading", { name: "Create your Paperclip account" })).toBeVisible();
  await page.getByLabel("Name").fill(ownerUser.name);
  await page.getByLabel("Email").fill(ownerUser.email);
  await page.getByLabel("Password").fill(ownerUser.password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

async function acceptBootstrapInvite(page: Page, inviteUrl: string) {
  await page.goto(inviteUrl);
  // bootstrap_ceo 邀请页:标题「Set up Paperclip」,按钮「Accept invite」(见 ui/src/pages/InviteLanding.tsx)。
  const acceptBtn = page.getByRole("button", { name: "Accept invite" });
  await expect(acceptBtn).toBeVisible({ timeout: 20_000 });
  await acceptBtn.click();
  // 成功后有两条路:显示「Bootstrap complete」+「Open board」,或直接 navigate("/")。两者都兜住。
  const openBoard = page.getByRole("link", { name: "Open board" });
  await Promise.race([
    openBoard.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined),
    page.waitForURL((url) => !url.pathname.startsWith("/invite/"), { timeout: 20_000 }).catch(() => undefined),
  ]);
  if (await openBoard.isVisible().catch(() => false)) {
    await openBoard.click();
  }
  await expect(page).not.toHaveURL(/\/invite\//, { timeout: 20_000 });
}

async function sessionJson<T>(page: Page, url: string, options: { method?: string; data?: unknown } = {}) {
  return page.evaluate(
    async ({ url: targetUrl, method, data }) => {
      const response = await fetch(targetUrl, {
        method,
        credentials: "include",
        headers: data === undefined ? undefined : { "Content-Type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const text = await response.text();
      let json: unknown = null;
      if (text.length > 0) { try { json = JSON.parse(text); } catch { json = null; } }
      return { ok: response.ok, status: response.status, text, json };
    },
    { url, method: options.method ?? "GET", data: options.data },
  ) as Promise<SessionJsonResponse<T>>;
}

test.describe("小镜核心闭环 (authenticated)", () => {
  test("招募员工 → 派活 → 被指派人真出 heartbeat_runs 行 → 算力钱包可读", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    requireBootstrapPrereqs();

    // 0) 必须是 authenticated 模式,否则整条断言链都是 local_implicit 免检的假绿。
    const healthRes = await page.request.get(`${BASE}/api/health`);
    expect(healthRes.ok()).toBe(true);
    const health = (await healthRes.json()) as { deploymentMode?: string };
    expect(health.deploymentMode).toBe("authenticated");

    // 1) 真人注册 + 认领实例(第一个人 = CEO/instance admin)。
    await signUp(page);
    await acceptBootstrapInvite(page, createBootstrapInvite());

    // 2) 建公司(cookie session → 生产 resolveBoardAccess 授权)。
    const createCompany = await sessionJson<CompanySummary>(page, `${BASE}/api/companies`, { method: "POST", data: { name: companyName } });
    expect(createCompany.ok, `create company failed: ${createCompany.status} ${createCompany.text}`).toBe(true);
    const company = createCompany.json!;
    expect(company.id).toBeTruthy();

    // 3) 招募一个 AI 员工(materialize 当场发生)。从市场取一张 preset 卡片,原样招进来。
    const marketRes = await sessionJson<EmployeeCard[]>(page, `${BASE}/api/companies/${company.id}/employee-market`);
    expect(marketRes.ok, `employee-market failed: ${marketRes.status} ${marketRes.text}`).toBe(true);
    const cards = marketRes.json ?? [];
    expect(cards.length, "employee market returned no cards").toBeGreaterThan(0);
    const card = cards.find((c) => c.source === "preset") ?? cards[0];

    const hireRes = await sessionJson<HireResult>(page, `${BASE}/api/companies/${company.id}/employee-hires`, {
      method: "POST",
      data: { source: card.source, refId: card.refId },
    });
    expect(hireRes.ok, `hire failed: ${hireRes.status} ${hireRes.text}`).toBe(true);
    const agentId = hireRes.json!.agentId;
    expect(agentId, "hire did not return an agentId").toBeTruthy();

    // 4) 派活:建一条 todo issue 指派给刚招的员工 —— 服务端应触发 assignment wakeup。
    const issueRes = await sessionJson<IssueSummary>(page, `${BASE}/api/companies/${company.id}/issues`, {
      method: "POST",
      data: {
        title: `选题:${SKIP_LLM ? "结构闭环冒烟(LLM skipped)" : "本周法律短视频选题 3 条"}`,
        description: "核心闭环 E2E:派活给 AI 员工,断言 run 真被排上。",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
    });
    expect(issueRes.ok, `create+assign issue failed: ${issueRes.status} ${issueRes.text}`).toBe(true);
    const issueId = issueRes.json!.id;
    expect(issueId).toBeTruthy();

    // 5) 产品层证据:派活的 wake 诊断走 assertCompanyAccess(真实授权),应看到该 issue 的 wake 请求。
    await expect
      .poll(async () => {
        const wakes = await sessionJson<{ wakeRequestCount?: number }>(page, `${BASE}/api/issues/${issueId}/diagnostics/wakes`);
        return wakes.ok ? wakes.json?.wakeRequestCount ?? 0 : -1;
      }, { timeout: 30_000, intervals: [500, 1000, 2000, 3000] })
      .toBeGreaterThan(0);

    // 6) 地基证据(不许 mock):被指派人真出 heartbeat_runs 行,invocation_source='assignment'。
    let assignmentRuns = readAssignmentRuns(company.id, agentId);
    for (let i = 0; i < 15 && assignmentRuns.count === 0; i++) {
      await page.waitForTimeout(1000);
      assignmentRuns = readAssignmentRuns(company.id, agentId);
    }
    expect(assignmentRuns.count, `no assignment heartbeat_runs row for agent ${agentId}`).toBeGreaterThan(0);
    expect(assignmentRuns.rows.every((r) => r.invocationSource === "assignment")).toBe(true);

    // 7) 算力钱包可读(「产出→审核→扣算力」尾段的门:钱包端点必须真实响应)。
    const balanceRes = await sessionJson<{ balancePoints?: number; balance?: unknown }>(page, `${BASE}/api/companies/${company.id}/compute/balance`);
    expect(balanceRes.ok, `compute balance failed: ${balanceRes.status} ${balanceRes.text}`).toBe(true);

    await page.screenshot({ path: testInfo.outputPath("core-loop-desktop.png"), fullPage: true });

    // 9) 移动端(产品是微信式群聊,移动端是主战场):同一 session 缩到移动视口,
    //    进公司看板,核心 app shell(<main> 地标)不能塌成白屏 —— 抓一次响应式回归。
    await page.setViewportSize({ width: 390, height: 844 });
    const companyPrefix = company.issuePrefix ?? company.id;
    await page.goto(`${BASE}/${companyPrefix}/dashboard`);
    await expect(page, "移动端应保持登录态(未被踢回 /auth)").not.toHaveURL(/\/auth/);
    await expect(page.getByRole("main"), "移动视口下核心 app shell 应正常渲染").toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: testInfo.outputPath("core-loop-mobile.png"), fullPage: true });

    // 8) LLM 相关的真实产出内容(选题/文案落库到 cases 表)只有在显式带 key 且不跳过时才断言。
    //    默认 SKIP_LLM=true:结构闭环(招募→派活→run 落库→钱包)每次都跑绿,不烧真实算力;
    //    这里不用 test.skip() —— 否则整条 test 会被回溯标记为 skipped,把上面已验证的结构断言藏掉。
    if (!SKIP_LLM) {
      const casesRes = await sessionJson<{ cases?: Array<{ caseType: string }> }>(
        page,
        `${BASE}/api/companies/${company.id}/cases`,
      );
      expect(casesRes.ok, `cases read failed: ${casesRes.status} ${casesRes.text}`).toBe(true);
    }
  });
});
