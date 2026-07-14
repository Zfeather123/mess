/**
 * 契约地板(baseline)的维护脚本。
 *
 *   pnpm contract:check              # 当前 DTO 是否还向后兼容基线(CI 里由契约测试兜底,这里给本地一个快速反馈)
 *   pnpm contract:accept-breaking    # 「我确认要破坏对外契约」—— 刷新基线
 *
 * OpenAPI **不在这里生成**:它由 `server/src/routes/openapi.ts` 从同一批 DTO 注册进已有的
 * `/api/openapi` 规格(components + 各路由响应)。一份规格,别搞两份。
 *
 * 基线是什么:`packages/shared/src/dto/api-contract.baseline.json`,冻结的字段清单。
 * 契约测试拿它跟当前 DTO 比 —— 少字段 / 改名 / 改类型 = 红。
 *
 * 它**故意**不会被顺手重新生成:一旦「改了名就自动刷基线」,这道闸门就自己把自己拆了
 * (改名 → 重生成 → 又绿了 → 前端线上静默拿到 undefined)。要动它必须显式跑
 * `--accept-breaking`,于是 PR 里会出现一段「我们从对外契约里删掉了 X」的 diff,
 * 由 reviewer 签字 —— 这正是我们想要的那个「有人为此负责」的时刻。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContractSchemas,
  findContractBreaks,
} from "../packages/shared/src/dto/contract.js";
import type { JsonSchema } from "../packages/shared/src/dto/json-schema.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(repoRoot, "packages/shared/src/dto/api-contract.baseline.json");

const acceptBreaking = process.argv.includes("--accept-breaking");

function writeBaseline(value: unknown) {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const current = buildContractSchemas();

let baseline: Record<string, JsonSchema> | null = null;
try {
  baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, JsonSchema>;
} catch {
  baseline = null;
}

if (!baseline) {
  writeBaseline(current);
  console.log(`✓ 基线首次生成 → ${baselinePath}`);
  process.exit(0);
}

const breaks = findContractBreaks(baseline, current);

if (acceptBreaking) {
  writeBaseline(current);
  console.log(`✓ 基线已刷新(--accept-breaking)→ ${baselinePath}`);
  for (const entry of breaks) console.log(`  ⚠ 已从对外契约移除/修改:${entry.detail}`);
  process.exit(0);
}

if (breaks.length > 0) {
  console.error("\n✗ 当前 DTO 破坏了契约基线:");
  for (const entry of breaks) console.error(`  - [${entry.kind}] ${entry.detail}`);
  console.error(
    "\n这不是「跑一下命令就好」的问题:上面每一条都会让前端静默拿到不一样的东西。\n" +
      "确实要改(且已经和前端对齐)就跑 pnpm contract:accept-breaking,\n" +
      "让基线的 diff 出现在 PR 里,由 reviewer 签字。\n",
  );
  process.exit(1);
}

console.log("✓ 当前 DTO 与契约地板向后兼容(加字段是安全的,不需要动基线)");
