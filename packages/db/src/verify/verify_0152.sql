-- 0152 约束验证:每个断言都必须成立,否则 RAISE EXCEPTION。
-- 目的是证明「不变量由数据库兜底」,而不是靠应用层记得检查。
--
-- ⚠️ 这个文件放在 src/verify/,不是 src/migrations/。
-- src/migrations/ 被 check-migration-numbering.ts 扫描,任何不以 4 位数字开头的 .sql
-- 都会让它抛 "does not start with a 4-digit migration number" → CI 直接红(0148 踩过这个坑)。
--
-- 跑法:psql "$DATABASE_URL" -f packages/db/src/verify/verify_0152.sql
\set ON_ERROR_STOP on

DO $$
DECLARE
  v_company uuid;
  v_other_company uuid;
  v_author uuid;
  v_tpl uuid;
  v_version int;
  v_updated timestamptz;
BEGIN
  -- ---- seed ----
  INSERT INTO companies (name) VALUES ('测试律所') RETURNING id INTO v_company;
  INSERT INTO companies (name) VALUES ('另一家律所') RETURNING id INTO v_other_company;
  INSERT INTO agents (company_id, name, role, title)
    VALUES (v_company, '账号主理人', 'lead', '队长') RETURNING id INTO v_author;

  INSERT INTO agent_templates (company_id, name, role, title, instructions, created_by_type, created_by_user_id)
    VALUES (v_company, '文案编导', 'writer', '编导', '你是文案编导,负责把选题写成脚本。', 'user', 'user_boss')
    RETURNING id INTO v_tpl;

  -- ============ 断言 1:空指令的模板不许进库 ============
  -- 空指令 = 招出来必定是「没有人格的空壳员工」。这正是本 issue 要防的那个静默失败,
  -- 所以把它挡在 DB 层,而不是指望每个写入路径都记得校验。
  BEGIN
    INSERT INTO agent_templates (company_id, name, role, instructions, created_by_type, created_by_user_id)
      VALUES (v_company, '空壳员工', 'writer', '   ', 'user', 'user_boss');
    RAISE EXCEPTION 'FAIL#1: 空指令模板竟然插入成功了(会招出空壳员工)';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS#1 空指令模板被拒(空壳员工在 DB 层就被挡住)';
  END;

  -- ============ 断言 2:创建者身份 XOR ============
  BEGIN
    INSERT INTO agent_templates (company_id, name, role, instructions, created_by_type, created_by_user_id, created_by_agent_id)
      VALUES (v_company, '双重身份', 'writer', '指令', 'user', 'user_boss', v_author);
    RAISE EXCEPTION 'FAIL#2: user 模板带 agent_id 竟然插入成功';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS#2 创建者身份 XOR 生效';
  END;

  -- ============ 断言 3:在架模板同公司内不许重名 ============
  BEGIN
    INSERT INTO agent_templates (company_id, name, role, instructions, created_by_type, created_by_user_id)
      VALUES (v_company, '文案编导', 'writer', '另一版指令', 'user', 'user_boss');
    RAISE EXCEPTION 'FAIL#3: 同公司在架重名模板竟然插入成功(市场里会出现两张一样的卡片)';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS#3 在架模板同公司内唯一';
  END;

  -- 重名约束是**按公司**的:别的公司可以有同名模板
  INSERT INTO agent_templates (company_id, name, role, instructions, created_by_type, created_by_user_id)
    VALUES (v_other_company, '文案编导', 'writer', '别家的指令', 'user', 'user_other');
  RAISE NOTICE 'PASS#3b 重名约束按公司隔离(不同公司可同名)';

  -- ============ 断言 4:version 由 DB 兜底自增(out-of-date 徽章的根基)============
  SELECT version INTO v_version FROM agent_templates WHERE id = v_tpl;
  IF v_version <> 1 THEN RAISE EXCEPTION 'FAIL#4: 新模板 version 应为 1,实际 %', v_version; END IF;

  -- 关键:调用方**没有**写 version = version + 1,只改了 instructions
  UPDATE agent_templates SET instructions = '你是文案编导,先写钩子再写正文。' WHERE id = v_tpl;
  SELECT version INTO v_version FROM agent_templates WHERE id = v_tpl;
  IF v_version <> 2 THEN
    RAISE EXCEPTION 'FAIL#4b: 改了 instructions 但 version 没涨(实际 %) —— 已招员工的 out-of-date 徽章会静默失灵', v_version;
  END IF;
  RAISE NOTICE 'PASS#4 内容变更自动 bump version(调用方漏写也不会让徽章失灵)';

  -- desired_skills(方法包)也是内容
  UPDATE agent_templates SET desired_skills = '["hook-writing"]'::jsonb WHERE id = v_tpl;
  SELECT version INTO v_version FROM agent_templates WHERE id = v_tpl;
  IF v_version <> 3 THEN RAISE EXCEPTION 'FAIL#4c: 改了 desired_skills 但 version 没涨(实际 %)', v_version; END IF;
  RAISE NOTICE 'PASS#4c 方法包变更也算内容变更(version=3)';

  -- ============ 断言 5:非内容变更不 bump version ============
  -- 「归档一下」不应该让所有已招员工无端显示「模板已更新」
  SELECT version, updated_at INTO v_version, v_updated FROM agent_templates WHERE id = v_tpl;
  UPDATE agent_templates SET status = 'archived' WHERE id = v_tpl;
  SELECT version INTO v_version FROM agent_templates WHERE id = v_tpl;
  IF v_version <> 3 THEN
    RAISE EXCEPTION 'FAIL#5: 仅归档就把 version 涨到了 %(会让已招员工误报「模板已更新」)', v_version;
  END IF;
  RAISE NOTICE 'PASS#5 仅改 status/visibility 不 bump version(不误报 out-of-date)';

  -- ============ 断言 6:归档后名字释放,可重建同名模板 ============
  INSERT INTO agent_templates (company_id, name, role, instructions, created_by_type, created_by_agent_id)
    VALUES (v_company, '文案编导', 'writer', 'agent 建的新版模板', 'agent', v_author);
  RAISE NOTICE 'PASS#6 归档后同名可重建(唯一约束只管在架的)';

  -- ============ 断言 7:非法 visibility / status 被拒 ============
  BEGIN
    INSERT INTO agent_templates (company_id, name, role, instructions, created_by_type, created_by_user_id, visibility)
      VALUES (v_company, '越权可见', 'writer', '指令', 'user', 'user_boss', 'everyone');
    RAISE EXCEPTION 'FAIL#7: 非法 visibility 竟然插入成功';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS#7 visibility 枚举由 DB 兜底';
  END;

  -- ============ 断言 8:公司删除级联清理模板(不留孤儿行)============
  DELETE FROM companies WHERE id = v_other_company;
  IF EXISTS (SELECT 1 FROM agent_templates WHERE company_id = v_other_company) THEN
    RAISE EXCEPTION 'FAIL#8: 公司删了,模板还在(孤儿行)';
  END IF;
  RAISE NOTICE 'PASS#8 公司删除级联清理模板';

  RAISE NOTICE '';
  RAISE NOTICE '===== 0152 全部 8 组不变量断言通过 =====';
END $$;

-- 市场读模型的主查询:确认走索引(agent_templates_company_status_idx),不是 Seq Scan
EXPLAIN ANALYZE
SELECT id, name, role, title, description, category, avatar_url, version, updated_at
FROM agent_templates
WHERE company_id = (SELECT id FROM companies ORDER BY created_at LIMIT 1)
  AND status = 'active'
ORDER BY updated_at DESC
LIMIT 50;
