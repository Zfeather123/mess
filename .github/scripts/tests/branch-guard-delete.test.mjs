import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDeletedBranch, resolveMergedState } from '../branch-guard-delete.mjs';

// —— 真告警必须还在(这是这个守卫存在的全部理由)——

test('删 main 一律报红', () => {
  const r = classifyDeletedBranch({ ref: 'main', merged: true });
  assert.equal(r.level, 'critical');
  assert.ok(r.hints.some((h) => h.includes('main-backup')));
});

test('删 master 一律报红', () => {
  assert.equal(classifyDeletedBranch({ ref: 'master', merged: true }).level, 'critical');
});

test('默认分支被切走后,删掉新的默认分支也报红', () => {
  const r = classifyDeletedBranch({ ref: 'trunk', defaultBranch: 'trunk', merged: true });
  assert.equal(r.level, 'critical');
});

// —— 误报必须消失(JIN-64)——

test('已合并的 feat/* 分支被删 → 静默,不报红', () => {
  const r = classifyDeletedBranch({ ref: 'feat/jin-61-squad-routing', merged: true });
  assert.equal(r.level, 'ok');
});

test('已合并的 agent/* 分支被删 → 静默,不报红', () => {
  const r = classifyDeletedBranch({ ref: 'agent/agent/b7ad9441', merged: true });
  assert.equal(r.level, 'ok');
});

test('未合并的 feature 分支被删 → 只警告,不判红', () => {
  const r = classifyDeletedBranch({ ref: 'feat/abandoned', merged: false });
  assert.equal(r.level, 'warn');
  assert.ok(r.summary.includes('没有合入'));
});

test('无法确认是否合入 → 只警告,不判红', () => {
  const r = classifyDeletedBranch({ ref: 'scratch/tmp', merged: null });
  assert.equal(r.level, 'warn');
  assert.ok(r.hints.length > 0, '要告诉人怎么把 commit 捞回来');
});

test('分支名前缀不再决定严重性:feat/* 和随便一个名字待遇一样', () => {
  const a = classifyDeletedBranch({ ref: 'feat/x', merged: true });
  const b = classifyDeletedBranch({ ref: 'whatever', merged: true });
  assert.equal(a.level, b.level);
});

// —— 合入状态是怎么查出来的 ——

test('有已 merged 的 PR → 已合入', () => {
  const merged = resolveMergedState('feat/x', {
    repo: 'o/r',
    run: () => [{ number: 27, mergedAt: '2026-07-14T12:32:00Z', headRefOid: 'abc' }],
  });
  assert.equal(merged, true);
});

test('PR 没合,但 head sha 已是 main 的祖先 → 已合入', () => {
  const calls = [];
  const merged = resolveMergedState('feat/x', {
    repo: 'o/r',
    run: (args) => {
      calls.push(args[0]);
      if (args[0] === 'pr') return [{ number: 9, mergedAt: null, headRefOid: 'abc' }];
      return 'behind';
    },
  });
  assert.equal(merged, true);
  assert.deepEqual(calls, ['pr', 'api']);
});

test('PR 没合,head sha 也不在 main 上 → 未合入', () => {
  const merged = resolveMergedState('feat/x', {
    repo: 'o/r',
    run: (args) => (args[0] === 'pr' ? [{ number: 9, mergedAt: null, headRefOid: 'abc' }] : 'diverged'),
  });
  assert.equal(merged, false);
});

test('压根没有关联 PR → null(无从判断)', () => {
  assert.equal(resolveMergedState('scratch/tmp', { repo: 'o/r', run: () => [] }), null);
});

test('gh 调不通(返回 null)时不假装知道答案', () => {
  assert.equal(resolveMergedState('feat/x', { repo: 'o/r', run: () => null }), null);
});
