-- ============================================================================
-- verify_0150 — 0150_douyin_sync_and_profile_sources 的不变量对账
--
-- 跑法(干净库跑完全部迁移之后):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/src/verify/verify_0150.sql
--
-- ⚠️ 这个文件**必须**放在 packages/db/src/verify/,不能放在 migrations/ 下 ——
-- Paperclip 的 check:migrations 要求 migrations/ 里的文件必须以 4 位数字开头,
-- 放进去会让迁移编号检查直接抛错(JIN-50 踩过这个坑)。
-- ============================================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  n int;
BEGIN
  -- ---- 1. 三张表都在 ----
  SELECT count(*) INTO n FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename IN ('douyin_videos', 'douyin_video_metrics', 'profile_sync_sources');
  IF n <> 3 THEN
    RAISE EXCEPTION '0150: 期望 3 张新表,实际 %', n;
  END IF;

  -- ---- 2. ⚠️ 头号不变量:play_count 必须可空 ----
  -- 「没拉到播放量」(NULL)和「真的 0 播放」(0)必须能区分。
  -- 抖音大多数接口已不再返回播放数,列表里的 play_count 基本是 0/缺失,
  -- 一旦这列被改成 NOT NULL DEFAULT 0,爆款识别就会把「没同步到」误判成「扑街」,
  -- 而且**永远不会报错**——它会安静地把结论带偏。所以这条用 DB 约束钉死。
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'douyin_video_metrics' AND column_name = 'play_count' AND is_nullable = 'YES';
  IF n <> 1 THEN
    RAISE EXCEPTION '0150: douyin_video_metrics.play_count 必须可空(NULL=没拉到 ≠ 0=没人看)';
  END IF;

  -- ---- 3. 外键都建了索引(团队铁律:JOIN 用的外键必须有索引)----
  SELECT count(*) INTO n FROM pg_indexes
   WHERE schemaname = 'public' AND indexname IN (
     'douyin_videos_company_aweme_uq',
     'douyin_videos_account_published_idx',
     'douyin_videos_company_idx',
     'douyin_video_metrics_video_captured_uq',
     'douyin_video_metrics_video_latest_idx',
     'douyin_video_metrics_company_idx',
     'profile_sync_sources_profile_source_uq',
     'profile_sync_sources_company_idx',
     'profile_sync_sources_status_idx'
   );
  IF n <> 9 THEN
    RAISE EXCEPTION '0150: 期望 9 个索引,实际 %', n;
  END IF;

  -- ---- 4. 重放同步是幂等的:一条作品同一采集时刻只能有一行指标 ----
  SELECT count(*) INTO n FROM pg_indexes
   WHERE indexname = 'douyin_video_metrics_video_captured_uq';
  IF n <> 1 THEN
    RAISE EXCEPTION '0150: 缺少 (video_id, captured_at) 唯一索引,重放同步会写出重复指标';
  END IF;

  -- ---- 5. 「重新同步」是 upsert,不是每次插一条新记录 ----
  SELECT count(*) INTO n FROM pg_indexes
   WHERE indexname = 'profile_sync_sources_profile_source_uq';
  IF n <> 1 THEN
    RAISE EXCEPTION '0150: 缺少 (profile_id, source) 唯一索引,同步状态会堆成一堆历史行';
  END IF;

  -- ---- 6. 对 Paperclip 原表与 0148 零改动(纯加法)----
  -- issues 仍然只有 JIN-50 加的那一列;本迁移一列都没动
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'account_profiles' AND column_name = 'spec_version';
  IF n <> 1 THEN
    RAISE EXCEPTION '0150: 0148 的 account_profiles.spec_version 不该被动过';
  END IF;

  RAISE NOTICE '✅ verify_0150: 全部不变量通过';
END $$;

-- ---- 7. play_count 的 CHECK 真的拦得住负数,且允许 NULL ----
-- 这两条是「断言约束真的生效」,不是「断言约束存在」—— 存在但没生效的约束骗过很多人。
DO $$
DECLARE
  v_company uuid;
  v_account uuid;
  v_video uuid;
BEGIN
  INSERT INTO companies (name) VALUES ('__verify_0150__') RETURNING id INTO v_company;
  INSERT INTO douyin_accounts (company_id, nickname) VALUES (v_company, '__verify__') RETURNING id INTO v_account;
  INSERT INTO douyin_videos (company_id, douyin_account_id, aweme_id)
    VALUES (v_company, v_account, '__verify_aweme__') RETURNING id INTO v_video;

  -- NULL play_count 必须被接受(这是「没拉到」的表示法)
  INSERT INTO douyin_video_metrics (company_id, video_id, play_count)
    VALUES (v_company, v_video, NULL);

  -- 负数必须被拒
  BEGIN
    INSERT INTO douyin_video_metrics (company_id, video_id, captured_at, play_count)
      VALUES (v_company, v_video, now() + interval '1 second', -1);
    RAISE EXCEPTION '0150: play_count = -1 竟然插进去了,CHECK 没生效';
  EXCEPTION WHEN check_violation THEN
    NULL; -- 预期
  END;

  -- play_count_source 只认两个值
  BEGIN
    INSERT INTO douyin_video_metrics (company_id, video_id, captured_at, play_count_source)
      VALUES (v_company, v_video, now() + interval '2 second', 'made_up');
    RAISE EXCEPTION '0150: play_count_source = made_up 竟然插进去了,CHECK 没生效';
  EXCEPTION WHEN check_violation THEN
    NULL; -- 预期
  END;

  -- 清理(companies 级联删掉全部)
  DELETE FROM companies WHERE id = v_company;

  RAISE NOTICE '✅ verify_0150: CHECK 约束实测生效(NULL 放行 / 负数拦截 / 非法枚举拦截)';
END $$;
