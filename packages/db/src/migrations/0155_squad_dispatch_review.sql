-- 0155:派单链的最后一跳 —— 队长「评审产出」
--
-- 背景:派单链 JIN-53 原文是三跳:
--   任务派给小队 → 队长决定分给谁 → **队长评审产出**
-- 前两跳已经落地(0154 的派单即评论 + decide 把 issue 从 backlog 提出来),
-- 第三跳整个不存在:`squad_dispatches` 没有终态,issue 做完时没有任何回调,
-- 队长把活派出去之后就「失联」—— 数据上根本无法表达「这次派单结束了」。
--
-- 这里落地两件事:
--
-- 1) **终态 `completed`**。state 从
--      pending | dispatched | reassigned | declined | failed
--    扩成
--      pending | dispatched | completed | reassigned | declined | failed
--    被指派人把 issue 转 in_review / done → dispatch 落 `completed` + `completed_at`。
--    队长评审后要打回 = 复用现有改派语义(老的置 `reassigned`,另开一条新 dispatch),
--    **不新增 `rejected`**:打回的本质就是「这活重新派一次」,原地改状态会把审计链改没。
--
-- 2) **评审公告的幂等标记**(与 0154 的 notified_at / dispatch_comment_id 同构)。
--    队长依然不是 issue 的 assignee,唤醒他仍然只能走「发一条真实评论 @ 他」这条路
--    (issue_comment_mentioned)。issue 的每一次写入都会过这个钩子,没有原子认领就会
--    给同一条派单刷 N 条「请评审」评论、把队长唤醒 N 次。
--      review_notified_at:认领标记,`UPDATE ... WHERE review_notified_at IS NULL` 原子认领。
--      review_comment_id :那条 @ 队长的评审评论。pause-hold 会回库校验「wake 的 actor ==
--                         评论作者」,留档便于排障与审计。
--
-- 手写 SQL(不跑 drizzle-kit generate,upstream snapshot 已坏)。
--
-- 锁与安全:
--   - 加可空列:PG 11+ 只改 catalog,不重写表,不锁读写。
--   - CHECK 约束是**放宽**(枚举只增不减),ADD CONSTRAINT 会扫一遍现有行做校验;
--     squad_dispatches 是小表(每条 issue 至多几行),且现有行的 state 全在新枚举里,
--     校验必过。DROP + ADD 之间只有 ACCESS EXCLUSIVE 的瞬时锁,不是长事务。
--   - 不建新索引:评审公告的取数入口是 `WHERE issue_id = ?`,已经走
--     `squad_dispatches_company_issue_idx`;review_notified_at 只是回表后的一个过滤位,
--     为它单开索引纯属写放大。

ALTER TABLE "squad_dispatches" DROP CONSTRAINT IF EXISTS "squad_dispatches_state_check";

ALTER TABLE "squad_dispatches"
  ADD CONSTRAINT "squad_dispatches_state_check"
  CHECK ("state" in ('pending', 'dispatched', 'completed', 'reassigned', 'declined', 'failed'));

ALTER TABLE "squad_dispatches"
  ADD COLUMN IF NOT EXISTS "completed_at" timestamptz;

ALTER TABLE "squad_dispatches"
  ADD COLUMN IF NOT EXISTS "review_notified_at" timestamptz;

ALTER TABLE "squad_dispatches"
  ADD COLUMN IF NOT EXISTS "review_comment_id" uuid REFERENCES "issue_comments"("id") ON DELETE SET NULL;

-- 回滚(DOWN):
--   ALTER TABLE "squad_dispatches" DROP COLUMN IF EXISTS "review_comment_id";
--   ALTER TABLE "squad_dispatches" DROP COLUMN IF EXISTS "review_notified_at";
--   ALTER TABLE "squad_dispatches" DROP COLUMN IF EXISTS "completed_at";
--   UPDATE "squad_dispatches" SET "state" = 'dispatched' WHERE "state" = 'completed';
--   ALTER TABLE "squad_dispatches" DROP CONSTRAINT IF EXISTS "squad_dispatches_state_check";
--   ALTER TABLE "squad_dispatches" ADD CONSTRAINT "squad_dispatches_state_check"
--     CHECK ("state" in ('pending', 'dispatched', 'reassigned', 'declined', 'failed'));
-- 回滚安全:收窄枚举前必须先把已有的 'completed' 行降回 'dispatched'(否则 ADD CONSTRAINT 校验失败),
-- 降回后语义 = 「派出去了、还没评审」,与旧代码的世界观一致;丢掉的只是「已完成待评审」这条信息。
