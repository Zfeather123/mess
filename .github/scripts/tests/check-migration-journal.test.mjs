import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMigrationJournal, readJournalAndFiles } from '../check-migration-journal.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const entry = (idx, tag) => ({ idx, version: '7', when: 1771300567463 + idx, tag, breakpoints: true });
const journalOf = (...entries) => ({ version: '7', dialect: 'postgresql', entries });
const filesOf = (...tags) => tags.map(t => `${t}.sql`);

test('绿档:journal 与文件一一对应', () => {
  const result = checkMigrationJournal({
    journal: journalOf(entry(0, '0000_init'), entry(1, '0001_users')),
    sqlFiles: filesOf('0000_init', '0001_users'),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.nextIdx, 2);
});

test('红档 1:重复 idx —— 两条迁移抢同一个号', () => {
  const result = checkMigrationJournal({
    journal: journalOf(
      entry(149, '0149_compute_reservations'),
      entry(150, '0150_douyin_sync_and_profile_sources'),
      entry(150, '0150_agent_templates'),
    ),
    sqlFiles: filesOf('0149_compute_reservations', '0150_douyin_sync_and_profile_sources', '0150_agent_templates'),
  });
  assert.equal(result.passed, false);
  const dup = result.failures.find(f => f.includes('idx 150 被'));
  assert.ok(dup, '应报出重复 idx');
  // 报错必须点名两条冲突的迁移,并给出「你应该用 0151」的自救提示。
  assert.ok(dup.includes('0150_douyin_sync_and_profile_sources'));
  assert.ok(dup.includes('0150_agent_templates'));
  assert.ok(dup.includes('0151'));
});

test('红档 2:journal 有 entry 但文件不存在', () => {
  const result = checkMigrationJournal({
    journal: journalOf(entry(0, '0000_init'), entry(1, '0001_ghost')),
    sqlFiles: filesOf('0000_init'),
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('0001_ghost') && f.includes('不存在')));
});

test('红档 3:文件存在但 journal 没登记 —— 这条迁移永远不会被执行', () => {
  const result = checkMigrationJournal({
    journal: journalOf(entry(0, '0000_init')),
    sqlFiles: filesOf('0000_init', '0001_orphan'),
  });
  assert.equal(result.passed, false);
  const miss = result.failures.find(f => f.includes('0001_orphan'));
  assert.ok(miss);
  assert.ok(miss.includes('0001'), '应告诉作者下一个可用编号');
});

test('红档 4:文件名前缀数字与 idx 对不上', () => {
  const result = checkMigrationJournal({
    journal: journalOf(entry(0, '0000_init'), entry(1, '0002_mislabeled')),
    sqlFiles: filesOf('0000_init', '0002_mislabeled'),
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('对不上')));
});

test('journal 损坏(没有 entries)→ 判红,不抛异常', () => {
  const result = checkMigrationJournal({ journal: {}, sqlFiles: [] });
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('entries'));
});

test('编号空洞只警告不判红(main 上 126/130 是历史回退留下的)', () => {
  const result = checkMigrationJournal({
    journal: journalOf(entry(0, '0000_init'), entry(2, '0002_after_gap')),
    sqlFiles: filesOf('0000_init', '0002_after_gap'),
  });
  assert.equal(result.passed, true, '空洞不能判红,否则每个 PR 都误报');
  assert.ok(result.warnings.some(w => w.includes('1')));
});

test('不带 NNNN_ 前缀的 .sql 文件不归这条门禁管', () => {
  const result = checkMigrationJournal({
    journal: journalOf(entry(0, '0000_init')),
    sqlFiles: [...filesOf('0000_init'), 'seed.sql'],
  });
  assert.equal(result.passed, true);
});

test('回归:当前仓库真实的 journal 必须是绿的(不能误报)', () => {
  const result = checkMigrationJournal(readJournalAndFiles(REPO_ROOT));
  assert.equal(result.passed, true, `真实 journal 被误判红:\n${result.failures.join('\n')}`);
});
