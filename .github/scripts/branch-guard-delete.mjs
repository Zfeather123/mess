#!/usr/bin/env node
/**
 * branch-guard-delete.mjs
 * 分支被删时,决定该多大声。
 *
 * 老逻辑把 `feat/*` / `agent/*` 也当成关键分支 → 每合一个 PR(`gh pr merge --delete-branch`
 * 或 GitHub 的 "Automatically delete head branches")就在 main 上留一条红的 Branch Guard。
 * 一个在正常操作下必然报红的守卫,会训练所有人无视它 —— 等 main 真出事那天就没人信了。
 *
 * 现在按「删掉之后有没有东西丢了」判,而不是按分支名前缀猜重要性:
 *   - main / master / 默认分支  → 不可替代,红(exit 1)
 *   - 已合入 main 的分支        → commit 已经在 main 里,删了零损失,静默
 *   - 未合入 / 无法确认         → 黄色 warning + 找回 sha 的办法,但不判红
 *
 * Export: classifyDeletedBranch({ ref, defaultBranch, merged }) → { level, summary, hints }
 *   merged: true(已合入) | false(确认未合入) | null(无从判断)
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 无论默认分支被切成什么,这两条永远是关键分支。 */
const ALWAYS_CRITICAL = ['main', 'master'];

const RESTORE_MAIN = 'git push origin refs/tags/main-backup:refs/heads/main   # main 专用';
const RESTORE_OTHER =
  '被删的 commit 通常还在:去 PR 页面 / Settings → Branches(最近删除)/ reflog 找回 sha,再 git push origin <sha>:refs/heads/<branch>';

export function classifyDeletedBranch({ ref, defaultBranch = 'main', merged = null }) {
  if (ALWAYS_CRITICAL.includes(ref) || ref === defaultBranch) {
    return {
      level: 'critical',
      summary: `⚠️ 关键分支 '${ref}' 被删除了!`,
      hints: [RESTORE_MAIN, RESTORE_OTHER],
    };
  }

  if (merged === true) {
    return {
      level: 'ok',
      summary: `✅ '${ref}' 已合入 ${defaultBranch},删除是 PR 的正常收尾 —— 不告警。`,
      hints: [],
    };
  }

  return {
    level: 'warn',
    summary:
      merged === false
        ? `'${ref}' 被删除,但它没有合入 ${defaultBranch} —— 如果那些 commit 还有用,现在去捞。`
        : `'${ref}' 被删除,查不到它关联的已合并 PR,无法确认是否已合入 ${defaultBranch}。`,
    hints: [RESTORE_OTHER],
  };
}

/**
 * 判断被删的分支是否已经进了 main。
 *
 * delete 事件的 payload **不带 sha**(只有 ref / ref_type),所以只能反查 PR:
 *   1. 有 head=<ref> 且已 merged 的 PR → 已合入(squash merge 也算,这是绝大多数情况)。
 *   2. 只有未合并的 PR → 拿它的 head sha 跟 main 比,是 main 的祖先就算已合入。
 *   3. 一个 PR 都没有 → null,无从判断(不判红,只提醒)。
 */
export function resolveMergedState(ref, { repo, run = ghJson } = {}) {
  const prs = run([
    'pr', 'list', '--repo', repo, '--head', ref, '--state', 'all',
    '--limit', '10', '--json', 'number,mergedAt,headRefOid',
  ]);
  if (!Array.isArray(prs) || prs.length === 0) return null;
  if (prs.some((pr) => pr.mergedAt)) return true;

  const sha = prs.map((pr) => pr.headRefOid).find(Boolean);
  if (!sha) return null;

  const cmp = run(['api', `repos/${repo}/compare/main...${sha}`, '--jq', '.status']);
  if (cmp === null) return null;
  // identical / behind = 这个 sha 已经能从 main 走到 → 已合入。
  return ['identical', 'behind'].includes(String(cmp).trim());
}

function ghJson(args) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8' });
    const text = out.trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    console.log(`(gh ${args.slice(0, 2).join(' ')} 失败,按「无法确认」处理:${err.message.split('\n')[0]})`);
    return null;
  }
}

function main() {
  const ref = process.env.REF ?? '';
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const defaultBranch = process.env.DEFAULT_BRANCH || 'main';
  if (!ref) {
    console.log('没有拿到被删的分支名,跳过。');
    return;
  }
  console.log(`被删的分支:${ref}`);

  const critical = ALWAYS_CRITICAL.includes(ref) || ref === defaultBranch;
  const merged = critical ? null : resolveMergedState(ref, { repo });
  const { level, summary, hints } = classifyDeletedBranch({ ref, defaultBranch, merged });

  if (level === 'critical') console.log(`::error::${summary}`);
  else if (level === 'warn') console.log(`::warning::${summary}`);
  else console.log(summary);

  for (const hint of hints) console.log(hint);
  if (level === 'critical') process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
