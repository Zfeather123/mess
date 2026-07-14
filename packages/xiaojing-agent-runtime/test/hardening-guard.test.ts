import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHardenedOptions } from '../src/options.js';

/**
 * 架构红线的静态守卫。
 *
 * 红线:agent 的模型请求**必须**经 buildHardenedOptions() 构造 options,
 * 不许绕过它直接调 SDK 的 query()。绕过去的后果不是"少个配置",而是:
 * **宿主机 ~/.claude 里的 MCP server 会被注入进我们的 agent loop** ——
 * 小镜跑在用户自己的电脑上,用户装的任何 MCP 工具都会凭空成为 AI 员工的能力。
 *
 * 上面那条 E2E 用例证明了"现在是对的";这条用例保证"以后也别改坏"。
 */

const SRC = path.join(import.meta.dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** 去掉块注释和行注释 —— 否则文档里写的 “不要直接调 query()” 会被当成违规代码。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('加固配置是强制的,不是可选的', () => {
  it('只有 host.ts 允许调用 SDK 的 query(),别处一律不许绕过', () => {
    const offenders = tsFiles(SRC)
      .filter((f) => path.basename(f) !== 'host.ts')
      .filter((f) => /\bquery\s*\(/.test(stripComments(readFileSync(f, 'utf8'))));

    expect(
      offenders.map((f) => path.relative(SRC, f)),
      '这些文件绕过 AgentHost 直接调了 query() —— 会让宿主机的 MCP 泄露进 agent loop',
    ).toEqual([]);
  });

  it('host.ts 通过 buildHardenedOptions() 构造 options', () => {
    const host = readFileSync(path.join(SRC, 'host.ts'), 'utf8');
    expect(host).toContain('buildHardenedOptions');
  });

  it('三个开关全部到位:tools:[] / settingSources:[] / strictMcpConfig:true', () => {
    const opts = buildHardenedOptions({
      gatewayBaseUrl: 'https://gw.example',
      sessionToken: 'tok',
      model: 'glm-4.6',
      mcpServers: {},
      toolNames: ['mcp__xiaojing__douyin_stats'],
      staticSystemPrompt: ['人设'],
      dynamicSystemPrompt: ['当前账号'],
    });

    expect(opts.tools, '不关内置工具 → Bash/Write/Edit 全上送给模型').toEqual([]);
    expect(opts.settingSources, '不隔离 → 宿主机 ~/.claude 的 MCP 会被注入').toEqual([]);
    expect(opts.strictMcpConfig, '不严格 → 项目 .mcp.json / 插件会混进来').toBe(true);
  });

  it('模型请求指向我们的网关,且客户端带的是 sessionToken 而不是模型 key', () => {
    const opts = buildHardenedOptions({
      gatewayBaseUrl: 'https://gw.example',
      sessionToken: 'xj_session_token',
      model: 'glm-4.6',
      mcpServers: {},
      toolNames: [],
      staticSystemPrompt: [],
      dynamicSystemPrompt: [],
    });

    expect(opts.env?.['ANTHROPIC_BASE_URL']).toBe('https://gw.example');
    expect(opts.env?.['ANTHROPIC_API_KEY']).toBe('xj_session_token');
  });

  it('env 是全量替换:不透传宿主机的 ANTHROPIC_* —— 否则用户环境能劫持我们的模型请求', () => {
    const prev = process.env['ANTHROPIC_BASE_URL'];
    process.env['ANTHROPIC_BASE_URL'] = 'https://attacker.example';
    try {
      const opts = buildHardenedOptions({
        gatewayBaseUrl: 'https://gw.example',
        sessionToken: 'tok',
        model: 'glm-4.6',
        mcpServers: {},
        toolNames: [],
        staticSystemPrompt: [],
        dynamicSystemPrompt: [],
      });
      expect(opts.env?.['ANTHROPIC_BASE_URL']).toBe('https://gw.example');
    } finally {
      if (prev === undefined) delete process.env['ANTHROPIC_BASE_URL'];
      else process.env['ANTHROPIC_BASE_URL'] = prev;
    }
  });
});
