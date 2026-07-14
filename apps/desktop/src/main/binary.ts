import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

/**
 * claude 原生二进制的解析与按需下载。
 *
 * ## 为什么要这么麻烦
 *
 * Agent SDK 的 agent loop 跑在一个原生二进制里(bun 打包的单文件),**248MB**。
 * 它是 npm 的 optionalDependency,按平台分发:@anthropic-ai/claude-agent-sdk-<platform>。
 *
 * 如果直接把它塞进安装包,Windows 用户要下 ~330MB 才能打开一个聊天窗口 —— 首次转化率
 * 会很难看。所以:**安装包不含二进制,首次启动时后台下载**,装完约 95MB,
 * 用户点开就能看到界面,下载在后台跑。
 *
 * ⚠️ 必须校验 sha256。这个二进制会以用户权限执行任意代码 —— 下载链路被劫持
 * 就等于 RCE。宁可下载失败,也不能执行一个校验不过的二进制。
 */

export interface BinarySpec {
  /** 形如 darwin-arm64 / win32-x64 */
  platformKey: string;
  /** 我们 CDN 上的地址(从服务端配置下发,便于换源)。 */
  url: string;
  sha256: string;
  sizeBytes: number;
}

export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveOptions {
  /** app.getPath('userData') —— 下载的二进制缓存在这里。 */
  userDataDir: string;
  spec: BinarySpec;
  /** 开发环境下 node_modules 里已经有了,直接用,别下载。 */
  devPath?: string;
  onProgress?: (received: number, total: number) => void;
  fetchImpl?: typeof fetch;
}

/**
 * 返回可执行的 claude 二进制路径,必要时下载。
 * 传给 Agent SDK 的 options.pathToClaudeCodeExecutable。
 */
export async function resolveClaudeBinary(opts: ResolveOptions): Promise<string> {
  // 开发环境:node_modules 里那份直接用
  if (opts.devPath && (await exists(opts.devPath))) {
    return opts.devPath;
  }

  const dir = path.join(opts.userDataDir, 'runtime', opts.spec.platformKey);
  const exe = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');

  // 已下载过:校验后复用。校验失败(磁盘损坏 / 被篡改)就重下。
  if (await exists(exe)) {
    if ((await sha256File(exe)) === opts.spec.sha256) return exe;
  }

  await mkdir(dir, { recursive: true });

  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(opts.spec.url);
  if (!res.ok || !res.body) {
    throw new Error(`下载 agent 运行时失败:HTTP ${res.status}`);
  }

  const tmp = `${exe}.part`;
  let received = 0;
  const total = Number(res.headers.get('content-length') ?? opts.spec.sizeBytes);

  const src = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  src.on('data', (chunk: Buffer) => {
    received += chunk.length;
    opts.onProgress?.(received, total);
  });
  await pipeline(src, createWriteStream(tmp));

  // 校验后才落到最终路径 —— 半个文件或被篡改的文件永远不会被执行
  const actual = await sha256File(tmp);
  if (actual !== opts.spec.sha256) {
    throw new Error(
      `agent 运行时校验失败:期望 ${opts.spec.sha256.slice(0, 12)}…,实际 ${actual.slice(0, 12)}…。` +
        `下载可能被劫持或损坏,已拒绝执行。`,
    );
  }

  const { rename } = await import('node:fs/promises');
  await rename(tmp, exe);
  if (process.platform !== 'win32') await chmod(exe, 0o755);

  return exe;
}
