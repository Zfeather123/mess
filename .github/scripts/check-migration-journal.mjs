#!/usr/bin/env node
/**
 * check-migration-journal.mjs
 * 守住手写迁移的不变量:_journal.json 的 idx 不重复、与 migrations/ 下的 .sql 文件一一对应。
 *
 * 为什么需要它(JIN-72,实证事故):多个 agent 并行开分支、各自手写迁移 + 手动追 journal 时,
 * 两条不同的迁移会抢到同一个 idx(0150 抢占过一次)。重复 idx 会让迁移执行顺序变成未定义,
 * 而本地只有自己那一条,永远复现不出来 —— 只有 CI 的合并视角看得见。
 *
 * 这里刻意不跑 drizzle-kit generate:Paperclip 的 snapshot 停在 0099 而迁移已到 0150,
 * 漂移会弹交互式 rename 提示,CI 无 TTY 直接卡死。这条门禁是给「手动追 journal」上保险,
 * 不是为了恢复自动生成。
 *
 * Export: checkMigrationJournal({ journal, sqlFiles }) → { passed, failures, warnings, nextIdx }
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = 'packages/db/src/migrations';
const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`;

/**
 * @param {object} args
 * @param {{ entries?: Array<{ idx: number, tag: string }> }} args.journal 解析后的 _journal.json
 * @param {string[]} args.sqlFiles migrations/ 下的 .sql 文件名(不含路径)
 */
export function checkMigrationJournal({ journal, sqlFiles }) {
  const failures = [];
  const warnings = [];

  const entries = Array.isArray(journal?.entries) ? journal.entries : null;
  if (!entries) {
    return {
      passed: false,
      failures: [`${JOURNAL_PATH} 缺少 entries 数组(文件损坏或不是 drizzle journal)。`],
      warnings: [],
      nextIdx: null,
    };
  }

  const idxs = entries.map(e => e.idx).filter(i => Number.isInteger(i));
  const maxIdx = idxs.length ? Math.max(...idxs) : -1;
  const nextIdx = maxIdx + 1;
  // 所有报错都带上这句 —— 撞车的人不用去翻 journal 就知道该改成几号。
  const hint = `main 当前 journal 末尾 idx = ${maxIdx} → 你应该用 ${String(nextIdx).padStart(4, '0')}`;

  // 1. 重复 idx:两条不同迁移抢同一个号 → 执行顺序未定义,必须红。
  const byIdx = new Map();
  for (const entry of entries) {
    if (!byIdx.has(entry.idx)) byIdx.set(entry.idx, []);
    byIdx.get(entry.idx).push(entry.tag);
  }
  for (const [idx, tags] of [...byIdx].sort((a, b) => a[0] - b[0])) {
    if (tags.length > 1) {
      failures.push(
        `_journal.json 里 idx ${idx} 被 ${tags.length} 条迁移同时占用:${tags.join(' 与 ')}。` +
        `两条不同的迁移抢同一个 idx 会让迁移执行顺序变成未定义(足以跑坏生产库)。` +
        `保留先合入的那条,把你自己那条重命名(.sql 文件名 + journal 的 idx/tag 一起改)。${hint}。`
      );
    }
  }

  // 2. journal 与文件双向对齐。
  const sqlSet = new Set(sqlFiles);
  const taggedFiles = new Set();
  for (const entry of entries) {
    const expected = `${entry.tag}.sql`;
    taggedFiles.add(expected);
    if (!sqlSet.has(expected)) {
      failures.push(
        `_journal.json 登记了 ${entry.tag}(idx ${entry.idx}),但 ${MIGRATIONS_DIR}/${expected} 不存在。` +
        `漏提交了 .sql 文件,或者 journal 里的 tag 拼错了。`
      );
    }
    // 3. 文件名前缀数字必须和 idx 对得上,否则 0151_foo 会被当成 idx 150 跑。
    const prefix = /^(\d+)_/.exec(entry.tag)?.[1];
    if (prefix === undefined) {
      failures.push(`_journal.json 的 tag "${entry.tag}" 不是 NNNN_name 格式,无法校验编号。`);
    } else if (Number(prefix) !== entry.idx) {
      failures.push(
        `_journal.json 里 ${entry.tag} 的文件名编号是 ${prefix},但 entry 的 idx 是 ${entry.idx} —— 对不上。` +
        `文件名前缀和 idx 必须一致。${hint}。`
      );
    }
  }

  for (const file of [...sqlFiles].sort()) {
    if (!/^\d+_.*\.sql$/.test(file)) continue; // 非 NNNN_ 前缀的文件不归这条门禁管
    if (!taggedFiles.has(file)) {
      failures.push(
        `${MIGRATIONS_DIR}/${file} 存在,但 _journal.json 里没有登记它 —— 这条迁移永远不会被执行。` +
        `手写迁移必须同时往 _journal.json 追一条 entry。${hint}。`
      );
    }
  }

  // 4. 编号空洞:只警告,不判红。main 上 126/130 是历史遗留的真空洞(迁移被回退过),
  //    判红会让每个 PR 都误报 —— 而空洞本身无害,drizzle 按 idx 升序跑,缺号不影响顺序。
  const seen = new Set(idxs);
  const gaps = [];
  for (let i = 0; i <= maxIdx; i++) if (!seen.has(i)) gaps.push(i);
  if (gaps.length) {
    warnings.push(`_journal.json 编号有空洞:${gaps.join(', ')}(历史回退留下的,无害,不判红)。`);
  }

  return { passed: failures.length === 0, failures, warnings, nextIdx };
}

export function readJournalAndFiles(root = process.cwd()) {
  const journal = JSON.parse(fs.readFileSync(path.join(root, JOURNAL_PATH), 'utf8'));
  const sqlFiles = fs
    .readdirSync(path.join(root, MIGRATIONS_DIR))
    .filter(f => f.endsWith('.sql'));
  return { journal, sqlFiles };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkMigrationJournal(readJournalAndFiles());
  for (const w of result.warnings) console.log(`::warning::${w}`);
  for (const f of result.failures) console.log(`::error::${f}`);
  if (result.passed) {
    console.log(`✅ 迁移 journal 一致。下一个可用编号:${String(result.nextIdx).padStart(4, '0')}`);
  }
  process.exit(result.passed ? 0 : 1);
}
