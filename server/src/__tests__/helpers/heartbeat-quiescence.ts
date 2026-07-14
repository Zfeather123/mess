import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

/**
 * 等 heartbeat 的 run 真正跑完再清表。
 *
 * ## 为什么需要「连续 N 次干净」而不是「看一眼没有 running 就走」
 *
 * `executeRun` 是 **fire-and-forget** 的(`heartbeat.ts:11038` 的 `void executeRun(...).catch(...)`),
 * 调用方拿不到它的 promise。于是「run 行的状态」和「这一次执行真的结束了」是**两件事**:
 *
 *  - **醒得太早**:wake 刚返回、run 还没被 claim 成 queued/running 时,表里一行都没有 ——
 *    只看一眼的话会误判成「跑完了」,当场清表,而 run 随后才被插进来。
 *  - **走得太早**:run 行已经落终态(completed/failed)了,但 `executeRun` 的尾巴还在写
 *    `agent_runtime_state` / run events / activity log。teardown 这时删掉 agents,
 *    那些尾部写入就会撞上 FK:
 *    `insert or update on table "agent_runtime_state" violates foreign key constraint
 *     "agent_runtime_state_agent_id_agents_id_fk"` —— 刷屏的报错,但测试是绿的
 *    (heartbeat 内部把它 catch 住了),于是**没人去修**。
 *
 * 所以这里要求「**连续 stableChecks 次**都观察到没有 queued/running」才认为静默:
 * 一次瞬时的 0 行不算数,尾部写入也有时间落地。
 *
 * 这只是**降噪**,不是加锁 —— 调用方仍然应该保留「删表失败就重试」的兜底,
 * 因为 fire-and-forget 天生没有可等待的终点。
 */
export async function waitForHeartbeatQuiescence(
  db: Db,
  opts: { stableChecks?: number; intervalMs?: number; timeoutMs?: number } = {},
) {
  const stableChecks = opts.stableChecks ?? 5;
  const intervalMs = opts.intervalMs ?? 80;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const deadline = Date.now() + timeoutMs;
  let clean = 0;

  while (Date.now() < deadline) {
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    const busy = runs.some((run) => run.status === "queued" || run.status === "running");
    clean = busy ? 0 : clean + 1;
    if (clean >= stableChecks) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
