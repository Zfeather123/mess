import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { platformKey, resolveClaudeBinary } from '../src/main/binary.js';

/**
 * claude 二进制会以用户权限执行任意代码。下载链路被劫持 == RCE。
 * 所以这几个用例是安全用例,不是功能用例 —— 校验不过就绝不能落盘执行。
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function fakeResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
}

describe('resolveClaudeBinary', () => {
  it('下载后校验 sha256 通过,落盘并返回路径', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xj-'));
    const body = 'FAKE_CLAUDE_BINARY';

    const exe = await resolveClaudeBinary({
      userDataDir: dir,
      spec: { platformKey: 'linux-x64', url: 'https://cdn/claude', sha256: sha(body), sizeBytes: body.length },
      fetchImpl: vi.fn(async () => fakeResponse(body)) as unknown as typeof fetch,
    });

    expect(await readFile(exe, 'utf8')).toBe(body);
  });

  it('sha256 不匹配时拒绝执行 —— 下载被劫持或损坏', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xj-'));

    await expect(
      resolveClaudeBinary({
        userDataDir: dir,
        spec: {
          platformKey: 'linux-x64',
          url: 'https://cdn/claude',
          sha256: sha('我们期望的二进制'),
          sizeBytes: 10,
        },
        // 攻击者返回了别的东西
        fetchImpl: vi.fn(async () => fakeResponse('EVIL_PAYLOAD')) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/校验失败/);
  });

  it('校验失败的文件不会留在最终路径上(只写到 .part)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xj-'));
    const exe = path.join(dir, 'runtime', 'linux-x64', process.platform === 'win32' ? 'claude.exe' : 'claude');

    await resolveClaudeBinary({
      userDataDir: dir,
      spec: { platformKey: 'linux-x64', url: 'https://cdn/x', sha256: sha('good'), sizeBytes: 4 },
      fetchImpl: vi.fn(async () => fakeResponse('BAD')) as unknown as typeof fetch,
    }).catch(() => {});

    await expect(readFile(exe)).rejects.toThrow(); // 最终路径上什么都没有
  });

  it('开发环境优先用 node_modules 里已有的那份,不发起下载', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xj-'));
    const devBin = path.join(dir, 'dev-claude');
    await writeFile(devBin, 'DEV');

    const fetchImpl = vi.fn();
    const exe = await resolveClaudeBinary({
      userDataDir: dir,
      devPath: devBin,
      spec: { platformKey: 'linux-x64', url: 'https://cdn/x', sha256: 'irrelevant', sizeBytes: 0 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(exe).toBe(devBin);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('已缓存且校验通过时直接复用,不重复下载 248MB', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'xj-'));
    const body = 'CACHED';
    const spec = {
      platformKey: 'linux-x64',
      url: 'https://cdn/claude',
      sha256: sha(body),
      sizeBytes: body.length,
    };
    const fetchImpl = vi.fn(async () => fakeResponse(body));

    await resolveClaudeBinary({ userDataDir: dir, spec, fetchImpl: fetchImpl as unknown as typeof fetch });
    await resolveClaudeBinary({ userDataDir: dir, spec, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('platformKey', () => {
  it('拼出 npm 分发用的平台标识', () => {
    expect(platformKey('darwin', 'arm64')).toBe('darwin-arm64');
    expect(platformKey('win32', 'x64')).toBe('win32-x64');
  });
});
