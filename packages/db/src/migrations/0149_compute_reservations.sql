-- 0149:算力预留(两阶段扣费的 hold 记录)
--
-- 为什么需要这张表:
-- 0148 的 compute_accounts 已经有 balance_points / frozen_points,能表达「冻结」这个状态,
-- 但**冻结的明细没有落地** —— 只有一个汇总数字。这带来两个问题:
--   1. settle/release 时不知道该回冲多少(没有 hold 记录可查)
--   2. 网关进程在 reserve 之后、settle 之前被 kill,frozen_points 会永远挂着,
--      用户的点数凭空消失,而且**没有任何线索能把它找回来**
--
-- 所以每笔冻结都必须有一行记录,带 TTL,让 sweeper 能扫出超时的 held 并退还。
--
-- 手写 SQL(不跑 drizzle-kit generate,upstream snapshot 已坏)。

CREATE TABLE IF NOT EXISTS "compute_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "compute_accounts"("id") ON DELETE CASCADE,
  -- 按最坏情况冻结的点数(output 上界 = max_tokens)
  "reserved_points" bigint NOT NULL,
  "state" text NOT NULL DEFAULT 'held',
  -- 幂等键:客户端重试同一请求不重复冻结
  "request_id" text NOT NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "model" text,
  -- TTL:超过这个时间还挂在 held,就是进程死了,sweeper 负责退还
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  CONSTRAINT "compute_reservations_points_positive" CHECK ("reserved_points" >= 0),
  CONSTRAINT "compute_reservations_state_check" CHECK ("state" IN ('held', 'settled', 'released'))
);

-- 幂等的兜底靠这条唯一索引,不是靠应用层判断
CREATE UNIQUE INDEX IF NOT EXISTS "compute_reservations_request_uq"
  ON "compute_reservations" ("request_id");

-- sweeper 的查询路径:扫 state='held' 且 expires_at < now()
CREATE INDEX IF NOT EXISTS "compute_reservations_state_expires_idx"
  ON "compute_reservations" ("state", "expires_at");

CREATE INDEX IF NOT EXISTS "compute_reservations_account_idx"
  ON "compute_reservations" ("account_id", "created_at");
