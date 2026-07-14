import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 红线守卫(JIN-65):**每个自己拼 prompt 的 adapter,join 列表里必须有 task context。**
 *
 * task context(buildPaperclipTaskMarkdown() 的产出,即 context.paperclipTaskMarkdown)
 * 装着 issue 标题/描述/父任务/唤醒评论,以及 agent 反馈笔记(「最近被纠正」/「下次注意」)。
 * 漏掉它不会报错、不会告警 —— agent 只是收不到任务上下文,静默失效。
 * codex-local / pi-local 就这么漏了很久,直到反馈注入功能撞上才被发现。
 *
 * 这条测试是防止同一个坑第三次出现的唯一办法:
 * 以后新加 adapter 忘了带 task context,CI 直接红。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const ADAPTERS_DIR = path.join(REPO_ROOT, "packages/adapters");

/** 共享的 acpx 引擎也自己拼 prompt,一并守。 */
const EXTRA_PROMPT_BUILDERS = [path.join(HERE, "acpx-engine/execute.ts")];

/** `const <name> = ...context.paperclipTaskMarkdown...` —— 绑定 task context 的局部变量名。 */
const TASK_CONTEXT_BINDING = /const\s+([A-Za-z0-9_$]+)\s*=[^;]*paperclipTaskMarkdown/g;
/** `joinPromptSections([ ... ])` 的数组字面量内容。 */
const JOIN_SECTIONS = /joinPromptSections\(\s*\[([^\]]*)\]/g;

async function collectPromptBuilders(): Promise<Array<{ name: string; file: string; source: string }>> {
  const entries = await readdir(ADAPTERS_DIR, { withFileTypes: true });
  const candidates = [
    ...entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        file: path.join(ADAPTERS_DIR, entry.name, "src/server/execute.ts"),
      })),
    ...EXTRA_PROMPT_BUILDERS.map((file) => ({ name: path.relative(REPO_ROOT, file), file })),
  ];

  const builders: Array<{ name: string; file: string; source: string }> = [];
  for (const candidate of candidates) {
    const source = await readFile(candidate.file, "utf8").catch(() => "");
    // 只守「自己拼 prompt」的 adapter。纯网关(如 openclaw-gateway)把 wake payload
    // 原样转发,没有 join 列表,不在此列。
    if (!source.includes("joinPromptSections([")) continue;
    builders.push({ ...candidate, source });
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

describe("adapter prompt assembly", () => {
  it("每个自己拼 prompt 的 adapter 都把 task context 放进了 join 列表", async () => {
    const builders = await collectPromptBuilders();

    // 防止 glob 写错时测试「全绿但什么都没扫到」。
    const scanned = builders.map((builder) => builder.name);
    expect(scanned).toEqual(expect.arrayContaining(["claude-local", "codex-local", "pi-local"]));

    const missing = builders
      .filter((builder) => {
        const bindings = [...builder.source.matchAll(TASK_CONTEXT_BINDING)].map((match) => match[1]);
        if (bindings.length === 0) return true;
        const joined = joinedIdentifiers(builder.source);
        return !bindings.some((binding) => joined.has(binding));
      })
      .map((builder) => path.relative(REPO_ROOT, builder.file));

    expect(
      missing,
      `这些 adapter 的 joinPromptSections 列表里没有 context.paperclipTaskMarkdown —— ` +
        `跑在上面的 agent 收不到 issue 上下文和反馈笔记,而且不会有任何报错。` +
        `照 claude-local 的写法补上(排在 renderedPrompt 之前):\n` +
        `  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();\n` +
        `缺失:${missing.join(", ") || "无"}`,
    ).toEqual([]);
  });
});
