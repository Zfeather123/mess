#!/usr/bin/env node
/**
 * 去品牌化:把 Paperclip 的品牌换成我们的。
 *
 * 设计取舍:品牌**在构建期注入**,不把改动提交进仓库 —— 这样我们对 upstream 文件的
 * git diff 保持为 0,每次 merge upstream 都不会在 index.html / webmanifest 上冲突。
 *
 *   node scripts/jin/apply-brand.mjs          # 应用到工作区(build / docker 之前跑)
 *   node scripts/jin/apply-brand.mjs --check  # 只校验锚点还在不在(CI 跑这个)
 *
 * --check 的意义:upstream 哪天改了 index.html 的结构,CI 会立刻红,而不是等到某次发版
 * 才发现网页标题又变回 "Paperclip" 了。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const checkOnly = process.argv.includes("--check");
const brand = JSON.parse(readFileSync(join(root, "branding", "brand.config.json"), "utf8"));

const problems = [];
const changes = [];

/** 对一个文件套用若干 [正则, 替换] 规则;规则匹配不到就是锚点丢了。 */
function rewrite(relPath, rules) {
  const abs = join(root, relPath);
  if (!existsSync(abs)) {
    problems.push(`缺文件:${relPath}`);
    return;
  }
  const original = readFileSync(abs, "utf8");
  let next = original;
  for (const [label, pattern, replacement] of rules) {
    if (!pattern.test(next)) {
      problems.push(`${relPath}:锚点「${label}」没匹配上 —— upstream 大概改了结构,请更新本脚本`);
      continue;
    }
    next = next.replace(pattern, replacement);
  }
  if (next !== original) {
    changes.push(relPath);
    if (!checkOnly) writeFileSync(abs, next);
  }
}

rewrite("ui/index.html", [
  ["html lang", /<html lang="[^"]*"/, `<html lang="${brand.lang}"`],
  ["title", /<title>[^<]*<\/title>/, `<title>${brand.title}</title>`],
  [
    "apple-mobile-web-app-title",
    /<meta name="apple-mobile-web-app-title" content="[^"]*" \/>/,
    `<meta name="apple-mobile-web-app-title" content="${brand.name}" />`,
  ],
  [
    "theme-color",
    /<meta name="theme-color" content="[^"]*" \/>/,
    `<meta name="theme-color" content="${brand.themeColor}" />`,
  ],
]);

rewrite("ui/public/site.webmanifest", [
  ["name", /"name":\s*"[^"]*"/, `"name": "${brand.name}"`],
  ["short_name", /"short_name":\s*"[^"]*"/, `"short_name": "${brand.shortName}"`],
  ["description", /"description":\s*"[^"]*"/, `"description": "${brand.description}"`],
  ["theme_color", /"theme_color":\s*"[^"]*"/, `"theme_color": "${brand.themeColor}"`],
]);

// 图标:branding/assets/ 里放什么就覆盖 ui/public/ 里的同名文件(favicon.svg / *.png / *.ico)。
// 现在是空的(品牌未定),等设计给了图标丢进去即可,脚本不用改。
const assetsDir = join(root, "branding", "assets");
if (existsSync(assetsDir)) {
  for (const file of readdirSync(assetsDir)) {
    if (file.startsWith(".")) continue;
    changes.push(`ui/public/${file}`);
    if (!checkOnly) copyFileSync(join(assetsDir, file), join(root, "ui", "public", file));
  }
}

if (problems.length > 0) {
  console.error("❌ 品牌注入失败:");
  for (const p of problems) console.error(`   - ${p}`);
  process.exit(1);
}

if (checkOnly) {
  console.log(`✅ 品牌锚点齐全(会改动 ${changes.length} 个文件:${changes.join(", ") || "无"})`);
} else {
  console.log(`✅ 已注入品牌「${brand.name}」,改动 ${changes.length} 个文件:${changes.join(", ") || "无"}`);
  console.log("   注意:这些改动不要提交 —— 品牌是构建期注入的,见 docs/jin/BRANDING.md");
}
