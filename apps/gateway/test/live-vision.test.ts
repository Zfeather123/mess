/**
 * 真机验收:三个视觉工具走网关跑通。
 *
 * 默认 skip。手动跑:RUN_LIVE_GLM=1 ... pnpm --filter @xiaojing/gateway test
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BillingService, InMemoryCreditLedger } from '@xiaojing/billing';
import { InMemorySessionResolver } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/server.js';
import { registerCoverFont } from '../src/vision/compose-cover.js';

const live = process.env.RUN_LIVE_GLM === '1' ? describe : describe.skip;

live('真机:视觉工具层(内部走 GLM 原生端点)', () => {
  it('read_image 读中文截图 + generate_image 出底图 + compose_cover 精确排字', async () => {
    const config = loadConfig();
    registerCoverFont(config.coverFontPath);

    const ledger = new InMemoryCreditLedger({ 'acct-1': 1_000_000 });
    const sessions = new InMemorySessionResolver({
      'session-abc': { accountId: 'acct-1', agentId: 'agent-dangan', issueId: 'JIN-51' },
    });
    const server = createGateway({ config, billing: new BillingService(ledger), sessions });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}`;

    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'x-api-key': 'session-abc', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json() as Promise<Record<string, never>>;
    };

    // ① read_image —— 中文合同截图,核对 6 个事实点
    const shot = readFileSync(process.env.TEST_IMAGE_PATH ?? new URL('./fixtures/test_contract_cn.png', import.meta.url)).toString('base64');
    const read = await post('/vision/read_image', {
      imageBase64: shot,
      question: '逐字读出:公司全名、工号、解除日期、经济补偿金、违约金。只读图上真实存在的字。',
    });
    const text = String(read['text'] ?? '');
    console.log('read_image →', text.replace(/\n+/g, ' ').slice(0, 200));

    const facts = ['杭州星澜网络科技有限公司', 'A20387', '2026年3月18日', '42,600', '30,000'];
    const hit = facts.filter((f) => text.replace(/,/g, ',').includes(f.replace(/,/g, ',')));
    console.log(`read_image 事实命中 ${hit.length}/${facts.length}`);
    expect(hit.length).toBe(facts.length);

    // ② generate_image —— 只出底图,明确禁止写字
    const gen = await post('/vision/generate_image', {
      prompt: '竖版海报底图,商务法律主题,深蓝色调,中央大片干净负空间',
      width: 1080,
      height: 1440,
    });
    const bgUrl = String(gen['url'] ?? '');
    console.log('generate_image →', bgUrl.slice(0, 80), gen['size']);
    expect(bgUrl).toMatch(/^https?:\/\//);

    const bgBuf = Buffer.from(await (await fetch(bgUrl)).arrayBuffer());

    // ③ compose_cover —— 标题代码渲染,一字不差
    const title = '被辞退还倒赔公司三万?这三个字千万别签';
    const cover = await post('/vision/compose_cover', {
      backgroundBase64: bgBuf.toString('base64'),
      title,
      subtitle: '劳动法 · 每天一个避坑点',
    });
    const png = Buffer.from(String(cover['imageBase64'] ?? ''), 'base64');
    writeFileSync(process.env.COVER_OUT ?? 'cover_ts_proof.png', png);
    console.log(`compose_cover → cover_ts_proof.png (${png.length} bytes)`);
    expect(png.length).toBeGreaterThan(10_000);

    // 扣费明细:read_image 按 token,generate_image 按张,compose_cover 不计费
    const events = await ledger.listCostEvents('acct-1');
    console.log('用量明细:', events.map((e) => `${e.model}=${e.points}点`).join(' | '));
    expect(events).toHaveLength(2); // compose_cover 是纯本地渲染,不产生费用

    server.close();
  }, 300_000);
});
