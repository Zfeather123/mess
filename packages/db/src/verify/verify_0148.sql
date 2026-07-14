-- 0148 约束验证:每个断言都必须成立,否则 RAISE EXCEPTION。
-- 目的是证明「不变量由数据库兜底」,而不是靠应用层记得检查。
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_company uuid;
  v_env uuid;
  v_leader uuid;
  v_writer uuid;
  v_diagnostician uuid;
  v_squad uuid;
  v_issue uuid;
  v_conv uuid;
  v_acct uuid;
  v_dy uuid;
  v_profile uuid;
  v_item uuid;
  v_seq bigint;
  v_ok boolean;
  v_cnt int;
BEGIN
  -- ---- seed ----
  INSERT INTO companies (name) VALUES ('测试律所') RETURNING id INTO v_company;
  INSERT INTO agents (company_id, name, role, title) VALUES (v_company, '账号主理人', 'lead', '队长') RETURNING id INTO v_leader;
  INSERT INTO agents (company_id, name, role, title) VALUES (v_company, '文案编导', 'writer', '编导') RETURNING id INTO v_writer;
  INSERT INTO agents (company_id, name, role, title) VALUES (v_company, '账号诊断师', 'analyst', '诊断') RETURNING id INTO v_diagnostician;

  INSERT INTO douyin_accounts (company_id, nickname, sec_uid) VALUES (v_company, '张律师说法', 'SEC_ABC') RETURNING id INTO v_dy;
  INSERT INTO squads (company_id, name, leader_agent_id, douyin_account_id)
    VALUES (v_company, '张律师内容小队', v_leader, v_dy) RETURNING id INTO v_squad;

  INSERT INTO squad_members (company_id, squad_id, member_type, agent_id, role)
    VALUES (v_company, v_squad, 'agent', v_leader, 'leader');
  INSERT INTO squad_members (company_id, squad_id, member_type, agent_id, role)
    VALUES (v_company, v_squad, 'agent', v_writer, 'member');

  -- ============ 断言 1:一个小队只能有一个队长 ============
  BEGIN
    INSERT INTO squad_members (company_id, squad_id, member_type, agent_id, role)
      VALUES (v_company, v_squad, 'agent', v_diagnostician, 'leader');
    RAISE EXCEPTION 'FAIL#1: 第二个队长竟然插入成功了';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS#1 单队长唯一约束生效';
  END;

  -- ============ 断言 2:成员身份 XOR(agent 成员不能带 user_id) ============
  BEGIN
    INSERT INTO squad_members (company_id, squad_id, member_type, agent_id, user_id, role)
      VALUES (v_company, v_squad, 'agent', v_diagnostician, 'user_x', 'member');
    RAISE EXCEPTION 'FAIL#2: agent 成员带 user_id 竟然插入成功';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS#2 成员身份 XOR 约束生效';
  END;

  -- ============ 断言 3:一个 issue 同时只能有一条 pending 派单 ============
  INSERT INTO issues (company_id, title, owner_squad_id) VALUES (v_company, '本周出3条视频', v_squad) RETURNING id INTO v_issue;
  INSERT INTO squad_dispatches (company_id, squad_id, issue_id, requested_by_type, requested_by_user_id)
    VALUES (v_company, v_squad, v_issue, 'user', 'user_boss');
  BEGIN
    INSERT INTO squad_dispatches (company_id, squad_id, issue_id, requested_by_type, requested_by_user_id)
      VALUES (v_company, v_squad, v_issue, 'user', 'user_boss');
    RAISE EXCEPTION 'FAIL#3: 重复 pending 派单竟然插入成功';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS#3 单 issue 单 pending 派单约束生效(防并发重复派单)';
  END;

  -- 队长决策:派给文案编导 -> 派单闭环 + issue 落到具体 agent
  UPDATE squad_dispatches SET state='dispatched', assigned_agent_id=v_writer, decided_by_agent_id=v_leader,
    decision_reason='文案类任务,编导最合适', decided_at=now() WHERE issue_id=v_issue AND state='pending';
  UPDATE issues SET assignee_agent_id=v_writer WHERE id=v_issue;
  -- 闭环后可再次派单(reassign 场景)
  INSERT INTO squad_dispatches (company_id, squad_id, issue_id, requested_by_type, requested_by_agent_id)
    VALUES (v_company, v_squad, v_issue, 'agent', v_leader);
  RAISE NOTICE 'PASS#3b 派单闭环后可重新派单(改派场景不被误锁)';

  -- ============ 断言 4:messages 每会话 seq 全序且唯一 ============
  INSERT INTO conversations (company_id, kind, title, squad_id) VALUES (v_company, 'group', '张律师内容群', v_squad) RETURNING id INTO v_conv;
  -- 序号分配:与消息插入同事务,自增返回 -> 无空洞、无重复
  UPDATE conversations SET last_seq = last_seq + 1 WHERE id = v_conv RETURNING last_seq INTO v_seq;
  INSERT INTO messages (company_id, conversation_id, seq, sender_type, sender_user_id, kind, body)
    VALUES (v_company, v_conv, v_seq, 'user', 'user_boss', 'text', '这周选题有了吗?');
  UPDATE conversations SET last_seq = last_seq + 1 WHERE id = v_conv RETURNING last_seq INTO v_seq;
  INSERT INTO messages (company_id, conversation_id, seq, sender_type, sender_agent_id, kind, card_type, card_payload, issue_id)
    VALUES (v_company, v_conv, v_seq, 'agent', v_writer, 'card', 'topic_list',
            '{"topics":[{"t":"离职补偿金怎么算"},{"t":"试用期被辞退"}]}'::jsonb, v_issue);
  BEGIN
    INSERT INTO messages (company_id, conversation_id, seq, sender_type, sender_user_id, kind, body)
      VALUES (v_company, v_conv, 2, 'user', 'user_boss', 'text', '重复 seq');
    RAISE EXCEPTION 'FAIL#4: 重复 seq 竟然插入成功';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS#4 会话内 seq 唯一(消息全序有保障)';
  END;

  -- ============ 断言 5:card 消息必须带 card_type ============
  BEGIN
    INSERT INTO messages (company_id, conversation_id, seq, sender_type, sender_agent_id, kind)
      VALUES (v_company, v_conv, 99, 'agent', v_writer, 'card');
    RAISE EXCEPTION 'FAIL#5: 无 card_type 的卡片消息竟然插入成功';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS#5 卡片消息必须带 card_type';
  END;

  -- ============ 断言 6:档案同一字段只有一条 active 事实 ============
  INSERT INTO account_profiles (company_id, douyin_account_id) VALUES (v_company, v_dy) RETURNING id INTO v_profile;
  INSERT INTO account_profile_facts (company_id, profile_id, field_key, value, source, source_priority, confidence)
    VALUES (v_company, v_profile, 'positioning', '"劳动法维权科普"'::jsonb, 'agent_inference', 10, 70);
  BEGIN
    INSERT INTO account_profile_facts (company_id, profile_id, field_key, value, source, source_priority, confidence)
      VALUES (v_company, v_profile, 'positioning', '"劳动纠纷实务"'::jsonb, 'user', 100, 100);
    RAISE EXCEPTION 'FAIL#6: 同字段第二条 active 事实竟然插入成功';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS#6 每字段单条 active 事实(冲突必须显式消解)';
  END;
  -- 正确的消解路径:旧事实置为 superseded,用户手填(优先级 100)胜出
  UPDATE account_profile_facts SET status='superseded', superseded_at=now()
    WHERE profile_id=v_profile AND field_key='positioning' AND status='active';
  INSERT INTO account_profile_facts (company_id, profile_id, field_key, value, source, source_priority, confidence)
    VALUES (v_company, v_profile, 'positioning', '"劳动纠纷实务"'::jsonb, 'user', 100, 100);
  SELECT (value #>> '{}') = '劳动纠纷实务' INTO v_ok
    FROM account_profile_facts WHERE profile_id=v_profile AND field_key='positioning' AND status='active';
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL#6b: 用户手填未能覆盖模型推断'; END IF;
  RAISE NOTICE 'PASS#6b 用户手填(priority 100)覆盖模型推断(priority 10)';

  -- ============ 断言 7:收藏引用权限 —— 默认开 + 例外关 ============
  INSERT INTO collection_items (company_id, douyin_account_id, title, body, default_citable, created_by_type, created_by_user_id)
    VALUES (v_company, v_dy, '爆款话术库', '开头三秒必须有钩子...', true, 'user', 'user_boss') RETURNING id INTO v_item;
  -- 产品要求:选题策划师可引用 ✅,账号诊断师不可 ❌
  INSERT INTO collection_citation_grants (company_id, item_id, agent_id, allowed, granted_by_user_id)
    VALUES (v_company, v_item, v_diagnostician, false, 'user_boss');

  -- 解析查询:allowed = COALESCE(例外, 默认)
  SELECT COALESCE(g.allowed, i.default_citable) INTO v_ok
    FROM collection_items i
    LEFT JOIN collection_citation_grants g ON g.item_id = i.id AND g.agent_id = v_writer
    WHERE i.id = v_item;
  IF NOT v_ok THEN RAISE EXCEPTION 'FAIL#7: 文案编导(无例外)应可引用'; END IF;

  SELECT COALESCE(g.allowed, i.default_citable) INTO v_ok
    FROM collection_items i
    LEFT JOIN collection_citation_grants g ON g.item_id = i.id AND g.agent_id = v_diagnostician
    WHERE i.id = v_item;
  IF v_ok THEN RAISE EXCEPTION 'FAIL#7b: 账号诊断师(例外=false)不应可引用'; END IF;
  RAISE NOTICE 'PASS#7 按员工粒度的可引用开关生效(默认开 + 例外关)';

  -- ============ 断言 8:算力账户 —— 余额不可为负 ============
  INSERT INTO compute_accounts (company_id, owner_type, balance_points) VALUES (v_company, 'company', 1000) RETURNING id INTO v_acct;
  BEGIN
    UPDATE compute_accounts SET balance_points = balance_points - 5000 WHERE id = v_acct;
    RAISE EXCEPTION 'FAIL#8: 余额被扣成负数了';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS#8 余额非负由 DB 兜底(超额扣费被拒,不靠应用层记得检查)';
  END;

  -- ============ 断言 9:扣费幂等 —— 重放不会重复扣钱 ============
  INSERT INTO compute_transactions (company_id, account_id, direction, points, balance_after, reason, agent_id, issue_id, idempotency_key)
    VALUES (v_company, v_acct, 'debit', 250, 750, 'consume', v_writer, v_issue, 'run:abc123:cost:1');
  UPDATE compute_accounts SET balance_points = 750, total_consumed_points = 250, version = version + 1 WHERE id = v_acct;
  BEGIN
    INSERT INTO compute_transactions (company_id, account_id, direction, points, balance_after, reason, agent_id, issue_id, idempotency_key)
      VALUES (v_company, v_acct, 'debit', 250, 500, 'consume', v_writer, v_issue, 'run:abc123:cost:1');
    RAISE EXCEPTION 'FAIL#9: 相同幂等键重复扣费成功了(真金白银的 bug)';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS#9 扣费幂等键生效(run 重试不会重复扣钱)';
  END;

  SELECT balance_points INTO v_seq FROM compute_accounts WHERE id = v_acct;
  IF v_seq <> 750 THEN RAISE EXCEPTION 'FAIL#9b: 余额应为 750,实际 %', v_seq; END IF;
  RAISE NOTICE 'PASS#9b 重试后余额仍为 750(未被二次扣减)';

  -- ============ 断言 10:定价可复算 —— 1M token = 5 元 = 500 点 ============
  SELECT points_per_1m_input INTO v_cnt FROM compute_pricing_rules WHERE company_id IS NULL AND model = '*';
  IF v_cnt <> 500 THEN RAISE EXCEPTION 'FAIL#10: 默认价应为 500 点/1M,实际 %', v_cnt; END IF;
  RAISE NOTICE 'PASS#10 默认定价 500 点/1M token(= 5 元,1 点 = 1 分)';

  -- ============ 断言 11:朋友圈作者 XOR ============
  BEGIN
    INSERT INTO moments (company_id, author_type, author_agent_id, author_user_id, content)
      VALUES (v_company, 'agent', v_writer, 'user_boss', '双重身份');
    RAISE EXCEPTION 'FAIL#11: 双重作者身份竟然插入成功';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS#11 朋友圈作者身份 XOR 生效';
  END;

  RAISE NOTICE '';
  RAISE NOTICE '===== 全部 11 组不变量断言通过 =====';
END $$;

-- 未读数 O(1) 计算(不扫 messages)
INSERT INTO conversation_members (company_id, conversation_id, member_type, user_id, last_read_seq)
SELECT c.company_id, c.id, 'user', 'user_boss', 1 FROM conversations c LIMIT 1;

SELECT c.title,
       c.last_seq,
       cm.last_read_seq,
       (c.last_seq - cm.last_read_seq) AS unread
FROM conversations c
JOIN conversation_members cm ON cm.conversation_id = c.id
WHERE cm.user_id = 'user_boss';
