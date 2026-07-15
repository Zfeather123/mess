-- 0155 约束验证:派单链的第三跳(队长评审产出)所依赖的不变量,由数据库兜底。
--
-- ⚠️ 这个文件放在 src/verify/,不是 src/migrations/。
-- src/migrations/ 被 check-migration-numbering.ts 扫描,任何不以 4 位数字开头的 .sql
-- 都会让它抛 "does not start with a 4-digit migration number" → CI 直接红(0148 踩过这个坑)。
--
-- 跑法:psql "$DATABASE_URL" -f packages/db/src/verify/verify_0155.sql
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_company uuid;
  v_leader uuid;
  v_writer uuid;
  v_squad uuid;
  v_issue uuid;
  v_comment uuid;
  v_dispatch uuid;
  v_new_dispatch uuid;
  v_state text;
  v_completed_at timestamptz;
BEGIN
  -- ---- seed ----
  INSERT INTO companies (name, issue_prefix) VALUES ('测试律所', 'V155A') RETURNING id INTO v_company;
  INSERT INTO agents (company_id, name, role) VALUES (v_company, '账号主理人', 'leader') RETURNING id INTO v_leader;
  INSERT INTO agents (company_id, name, role) VALUES (v_company, '文案编导', 'writer') RETURNING id INTO v_writer;
  INSERT INTO squads (company_id, name, leader_agent_id)
    VALUES (v_company, '抖音一队', v_leader) RETURNING id INTO v_squad;
  INSERT INTO issues (company_id, identifier, issue_number, title, status, owner_squad_id)
    VALUES (v_company, 'V155-1', 1, '婚前财产口播脚本', 'backlog', v_squad) RETURNING id INTO v_issue;

  INSERT INTO squad_dispatches (company_id, squad_id, issue_id, state, requested_by_type)
    VALUES (v_company, v_squad, v_issue, 'pending', 'system') RETURNING id INTO v_dispatch;

  -- ============ 断言 1:终态 'completed' 进得了库 ============
  -- 修复前 state 枚举是 pending|dispatched|reassigned|declined|failed —— 根本没有终态可落,
  -- 「这次派单结束了」在数据上无法表达,队长也就永远不知道活干完了。
  UPDATE squad_dispatches
    SET state = 'dispatched', assigned_agent_id = v_writer, decision_reason = '他口播转化最好', decided_at = now()
    WHERE id = v_dispatch;
  UPDATE squad_dispatches SET state = 'completed', completed_at = now() WHERE id = v_dispatch;
  SELECT state, completed_at INTO v_state, v_completed_at FROM squad_dispatches WHERE id = v_dispatch;
  IF v_state <> 'completed' OR v_completed_at IS NULL THEN
    RAISE EXCEPTION 'FAIL#1: 派单没能落到终态 completed(state=%, completed_at=%)', v_state, v_completed_at;
  END IF;
  RAISE NOTICE 'PASS#1 派单可以落终态 completed(库里查得到「这次派单结束了」)';

  -- ============ 断言 2:非法状态照样被 DB 挡住(枚举是放宽,不是拆掉)============
  BEGIN
    UPDATE squad_dispatches SET state = 'reviewed' WHERE id = v_dispatch;
    RAISE EXCEPTION 'FAIL#2: 非法 state 竟然写进去了(CHECK 约束被拆没了)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS#2 state 枚举仍由 DB 兜底(只多了 completed,没放开)';
  END;

  -- ============ 断言 3:评审公告的幂等标记可写、且能退回 ============
  -- review_notified_at 是原子认领标记(UPDATE ... WHERE review_notified_at IS NULL)。
  -- wake 落空时要能退回 NULL 让下一次 issue 写入重新公告 —— 所以它必须可空。
  INSERT INTO issue_comments (company_id, issue_id, author_type, body)
    VALUES (v_company, v_issue, 'system', '产出待评审') RETURNING id INTO v_comment;
  UPDATE squad_dispatches SET review_notified_at = now(), review_comment_id = v_comment WHERE id = v_dispatch;
  IF (SELECT review_notified_at FROM squad_dispatches WHERE id = v_dispatch) IS NULL THEN
    RAISE EXCEPTION 'FAIL#3: 认领标记没写进去';
  END IF;
  UPDATE squad_dispatches SET review_notified_at = NULL WHERE id = v_dispatch;
  IF (SELECT review_notified_at FROM squad_dispatches WHERE id = v_dispatch) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL#3b: 认领退不回去(wake 落空后就永远不会重播了)';
  END IF;
  RAISE NOTICE 'PASS#3 评审公告的认领标记可写可退(wake 落空能重播)';

  -- ============ 断言 4:评论被删,派单不跟着消失(ON DELETE SET NULL)============
  UPDATE squad_dispatches SET review_comment_id = v_comment WHERE id = v_dispatch;
  DELETE FROM issue_comments WHERE id = v_comment;
  IF NOT EXISTS (SELECT 1 FROM squad_dispatches WHERE id = v_dispatch) THEN
    RAISE EXCEPTION 'FAIL#4: 删一条评论把派单审计记录级联删掉了';
  END IF;
  IF (SELECT review_comment_id FROM squad_dispatches WHERE id = v_dispatch) IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL#4b: 评论没了,review_comment_id 还挂着悬空引用';
  END IF;
  RAISE NOTICE 'PASS#4 review_comment_id 是 ON DELETE SET NULL(审计行不被评论删除牵连)';

  -- ============ 断言 5:打回 = 老的置 reassigned + 另开一条,审计链不断 ============
  -- 打回**不是**原地改状态。这条断言钉的是「completed 的派单可以被 reassigned 取代」,
  -- 并且两条记录同时存在(谁做的、为什么打回,都查得到)。
  UPDATE squad_dispatches SET state = 'reassigned' WHERE id = v_dispatch;
  INSERT INTO squad_dispatches (
    company_id, squad_id, issue_id, state, requested_by_type,
    assigned_agent_id, decided_by_agent_id, decision_reason, decided_at, attempt_count
  )
    VALUES (
      v_company, v_squad, v_issue, 'dispatched', 'system',
      v_writer, v_leader, '开头钩子太弱,重写前 3 秒', now(), 2
    )
    RETURNING id INTO v_new_dispatch;
  IF (SELECT count(*) FROM squad_dispatches WHERE issue_id = v_issue) <> 2 THEN
    RAISE EXCEPTION 'FAIL#5: 打回后审计链断了(同一条 issue 上应该有 2 条派单记录)';
  END IF;
  RAISE NOTICE 'PASS#5 打回走「老的置 reassigned + 另开一条」,审计链完整(2 条记录并存)';

  -- ============ 断言 6:pending 唯一约束仍然有效(打回不能凭空造出第二条待办)============
  UPDATE squad_dispatches SET state = 'pending' WHERE id = v_new_dispatch;
  BEGIN
    INSERT INTO squad_dispatches (company_id, squad_id, issue_id, state, requested_by_type)
      VALUES (v_company, v_squad, v_issue, 'pending', 'system');
    RAISE EXCEPTION 'FAIL#6: 同一条 issue 竟然能有两条 pending 派单';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS#6 一条 issue 同时只能有一条 pending 派单(squad_dispatches_issue_pending_uq 仍在)';
  END;

  RAISE NOTICE '';
  RAISE NOTICE '===== 0155 全部 6 组不变量断言通过 =====';
END $$;

-- 队长的评审队列(「派给我小队的活,哪些做完了等我看」):确认走
-- squad_dispatches_company_issue_idx / pending_queue_idx,不是全表 Seq Scan。
EXPLAIN ANALYZE
SELECT id, issue_id, assigned_agent_id, decision_reason, completed_at
FROM squad_dispatches
WHERE company_id = (SELECT id FROM companies ORDER BY created_at LIMIT 1)
  AND state = 'completed'
ORDER BY completed_at DESC
LIMIT 50;
