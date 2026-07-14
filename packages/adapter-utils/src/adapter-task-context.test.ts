import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 红线守卫(JIN-65 / JIN-80):**每个 adapter 包都必须把 task context 送到员工手里。**
 *
 * task context(buildPaperclipTaskMarkdown() 的产出,即 context.paperclipTaskMarkdown)
 * 装着 issue 标题/描述/父任务/唤醒评论,以及 agent 反馈笔记(「最近被纠正」/「下次注意」)。
 * 漏掉它不会报错、不会告警 —— agent 只是收不到任务上下文,静默失效。
 * codex-local / pi-local 就这么漏了很久,直到反馈注入功能撞上才被发现。
 *
 * 这条测试的第一版只扫「含 `joinPromptSections([` 字样的文件」——
 * openclaw-gateway 不用 joinPromptSections 拼 prompt,于是正好被漏掉,
 * 它把 ctx.context 只喂给 onMeta 遥测,跑在它上面的员工一条反馈笔记都收不到,
 * 而守卫测试一直是绿的(JIN-80)。**守卫自己有盲区,比没有守卫更危险。**
 *
 * 所以现在的口径是**全量 adapter 包**:packages/adapters/* 每个包里的每个 execute.ts,
 * 加上共享的 acpx 引擎。不拼 prompt 的包必须在 NOT_A_PROMPT_BUILDER 里显式登记并写明理由 ——
 * 不许再靠「扫不到」蒙混过关。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const ADAPTERS_DIR = path.join(REPO_ROOT, "packages/adapters");

/** 共享的 acpx 引擎也自己拼 prompt,和 adapter 包一起守。 */
const EXTRA_PACKAGES = [{ name: "adapter-utils/acpx-engine", dir: path.join(HERE, "acpx-engine") }];

/**
 * 白名单:**不自己把 wake payload 发给模型**的包。每一条都要写清理由,
 * 并且理由必须是「它根本没有出站 prompt / message」,而不是「它扫不到」。
 */
const NOT_A_PROMPT_BUILDER: Record<string, string> = {
  "hermes-gateway":
    "兼容 shim:整包只 re-export @paperclipai/hermes-paperclip-adapter/gateway/server 的 execute,"
    + "真正拼 prompt 的是 packages/adapters/hermes(本测试单独扫它)。",
};

/** `const <name> = ...context.paperclipTaskMarkdown...` —— 绑定 task context 的局部变量名。 */
const TASK_CONTEXT_BINDING = /const\s+([A-Za-z0-9_$]+)\s*=[^;]*paperclipTaskMarkdown/g;
/** 同上,用来把声明语句整条剔掉(只剩「使用」)。 */
const TASK_CONTEXT_DECLARATION = /const\s+[A-Za-z0-9_$]+\s*=[^;]*paperclipTaskMarkdown[^;]*;/g;
/** `joinPromptSections([ ... ])` 的数组字面量内容。 */
const JOIN_SECTIONS = /joinPromptSections\(\s*\[([^\]]*)\]/g;
/**
 * `ctx.onMeta({ ... })` —— 遥测。把 ctx.context 交给 onMeta **不算**把 task context
 * 送到员工手里:openclaw-gateway 当初就是只做了这个。判定时必须先把它剔掉。
 */
const ONMETA_CALL = /(?:ctx\.)?onMeta\s*\(\s*\{[^{}]*\}\s*\)/g;

interface PromptBuilderFile {
  pkg: string;
  file: string;
  source: string;
}

/** 递归收集一个包 src 下的所有 execute.ts(排除测试文件)。 */
async function collectExecuteFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...(await collectExecuteFiles(full)));
    } else if (entry.name === "execute.ts" || entry.name.endsWith(".execute.ts")) {
      files.push(full);
    }
  }
  return files;
}

async function collectPackages(): Promise<Array<{ name: string; dir: string }>> {
  const entries = await readdir(ADAPTERS_DIR, { withFileTypes: true });
  return [
    ...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, dir: path.join(ADAPTERS_DIR, entry.name) })),
    ...EXTRA_PACKAGES,
  ];
}

async function collectPromptBuilders(pkg: { name: string; dir: string }): Promise<PromptBuilderFile[]> {
  const files = await collectExecuteFiles(pkg.dir);
  const builders: PromptBuilderFile[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8").catch(() => "");
    if (source.trim().length === 0) continue;
    builders.push({ pkg: pkg.name, file, source });
  }
  return builders;
}

function joinedIdentifiers(source: string): Set<string> {
  const identifiers = new Set<string>();
  for (const match of source.matchAll(JOIN_SECTIONS)) {
    for (const token of match[1].split(",")) {
      const name = token.trim();
      if (name) identifiers.add(name);
    }
  }
  return identifiers;
}

/**
 * task context 有没有真的流向员工?
 * 绑定必须存在,并且在**声明语句和 onMeta 遥测之外**至少被用到一次 ——
 * 光 `const x = context.paperclipTaskMarkdown` 然后不用,和没写没区别。
 */
function carriesTaskContext(source: string): boolean {
  const outbound = source.replace(ONMETA_CALL, "");
  const bindings = [...outbound.matchAll(TASK_CONTEXT_BINDING)].map((match) => match[1]);
  if (bindings.length === 0) return false;

  const usage = outbound.replace(TASK_CONTEXT_DECLARATION, "");
  return bindings.some((binding) => new RegExp(`\\b${binding}\\b`).test(usage));
}

describe("adapter prompt assembly", () => {
  it("每个 adapter 包都把 task context 送进了发给员工的 prompt / message", async () => {
    const packages = await collectPackages();

    // 防止 glob 写错时测试「全绿但什么都没扫到」。
    const scanned = packages.map((pkg) => pkg.name);
    expect(scanned).toEqual(
      expect.arrayContaining([
        "claude-local",
        "codex-local",
        "pi-local",
        "openclaw-gateway",
        "hermes",
        "adapter-utils/acpx-engine",
      ]),
    );

    const missing: string[] = [];
    for (const pkg of packages) {
      if (pkg.name in NOT_A_PROMPT_BUILDER) continue;

      const builders = await collectPromptBuilders(pkg);
      if (builders.length === 0) {
        missing.push(`${pkg.name}(整个包里找不到 execute.ts —— 它凭什么不拼 prompt?)`);
        continue;
      }
      for (const builder of builders) {
        if (!carriesTaskContext(builder.source)) {
          missing.push(path.relative(REPO_ROOT, builder.file));
        }
      }
    }

    expect(
      missing,
      `这些 adapter 没把 context.paperclipTaskMarkdown 送进发给员工的 prompt / message —— ` +
        `跑在上面的 agent 收不到 issue 上下文和反馈笔记(「最近被纠正」/「下次注意」),` +
        `而且不会有任何报错。喂给 onMeta 遥测不算数,必须进出站文本。\n` +
        `拼 prompt 的照 claude-local 写(排在 renderedPrompt 之前):\n` +
        `  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();\n` +
        `网关类照 openclaw-gateway 写(把它拼进 wake message)。\n` +
        `真的不拼 prompt,就去 NOT_A_PROMPT_BUILDER 显式登记并写明理由。\n` +
        `缺失:${missing.join(", ") || "无"}`,
    ).toEqual([]);
  });

  it("拼 prompt 的 adapter,task context 必须在 joinPromptSections 的列表里", async () => {
    const packages = await collectPackages();

    const missing: string[] = [];
    for (const pkg of packages) {
      if (pkg.name in NOT_A_PROMPT_BUILDER) continue;
      for (const builder of await collectPromptBuilders(pkg)) {
        if (!builder.source.includes("joinPromptSections([")) continue;
        const bindings = [...builder.source.matchAll(TASK_CONTEXT_BINDING)].map((match) => match[1]);
        const joined = joinedIdentifiers(builder.source);
        if (!bindings.some((binding) => joined.has(binding))) {
          missing.push(path.relative(REPO_ROOT, builder.file));
        }
      }
    }

    expect(
      missing,
      `这些 adapter 的 joinPromptSections 列表里没有 context.paperclipTaskMarkdown:${
        missing.join(", ") || "无"
      }`,
    ).toEqual([]);
  });

  it("白名单只允许「整包没有出站 prompt」的包,且必须写明理由", async () => {
    for (const [name, reason] of Object.entries(NOT_A_PROMPT_BUILDER)) {
      expect(reason.trim().length, `${name} 的白名单理由不能为空`).toBeGreaterThan(20);
    }
    // hermes-gateway 一旦不再是纯 re-export(自己长出了 execute.ts),白名单立即失效。
    const gatewayExecutes = await collectExecuteFiles(path.join(ADAPTERS_DIR, "hermes-gateway"));
    expect(
      gatewayExecutes,
      "hermes-gateway 有了自己的 execute.ts —— 它不再是纯 shim,把它从 NOT_A_PROMPT_BUILDER 里摘掉并守起来",
    ).toEqual([]);
  });
});
