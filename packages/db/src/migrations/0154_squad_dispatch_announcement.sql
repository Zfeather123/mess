-- 0154:派单公告(队长唤醒 —— Option B「派单即评论」)
--
-- 背景:队长不是 issue 的 assignee(派单那一刻 assignee 就是 NULL,等他来指派),
-- 而 heartbeat 的 claim 阶段会断言 `issue.assignee_agent_id === run.agent_id`,
-- 只对「带真实 comment 的交互唤醒」放行。所以派单服务改成:在 issue 上发一条
-- 真实评论并 @ 队长,复用生产上唯一一条能唤醒非 assignee 的路径(issue_comment_mentioned)。
--
-- 这里要落地的是**幂等**:一条 pending 派单只允许公告一次。
-- 不能靠应用层「先查再插」—— 并发下 issue 的 create/update 都会调派单钩子,
-- 会给同一条派单发两条评论、唤醒队长两次。
--   notified_at:公告认领标记。认领用 `UPDATE ... WHERE notified_at IS NULL` 原子完成,
--               抢不到的那一方直接跳过(不是错误)。
--   dispatch_comment_id:那条评论的真身。issue-tree-control 的 pause-hold 会回库校验
--               「wake 的 actor == 评论作者」,留档便于排障与审计。
--
-- 手写 SQL(不跑 drizzle-kit generate,upstream snapshot 已坏)。
-- 纯加法:只加可空列,不改任何既有列/约束,不锁表(PG 11+ 加可空列只改 catalog)。

ALTER TABLE "squad_dispatches"
  ADD COLUMN IF NOT EXISTS "notified_at" timestamptz;

ALTER TABLE "squad_dispatches"
  ADD COLUMN IF NOT EXISTS "dispatch_comment_id" uuid REFERENCES "issue_comments"("id") ON DELETE SET NULL;

-- 不建索引:公告的取数入口是 `WHERE issue_id = ? AND state = 'pending'`,
-- 已经走 `squad_dispatches_issue_pending_uq`(部分唯一索引,只覆盖 pending),
-- notified_at 只是回表后的一个过滤位。为它单独建索引纯属写放大。
-- (真要加,必须 CREATE INDEX CONCURRENTLY —— 而 drizzle 的 migrator 把每个迁移
--  包在事务里,CONCURRENTLY 在事务里跑不了,得单独走 out-of-band 迁移。)
--
-- 回滚(DOWN):
--   ALTER TABLE "squad_dispatches" DROP COLUMN IF EXISTS "dispatch_comment_id";
--   ALTER TABLE "squad_dispatches" DROP COLUMN IF EXISTS "notified_at";
-- 回滚安全:两列都是可空的新增列,旧代码不读不写它们;丢掉的只是公告幂等标记
-- (最坏情况 = 重启公告后队长被重复唤醒一次,不会丢数据)。
