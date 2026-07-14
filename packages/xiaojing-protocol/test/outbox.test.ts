import { describe, expect, it, vi } from 'vitest';
import { MemoryOutboxStore, Outbox } from '../src/outbox.js';
import { backoffDelay } from '../src/connection.js';
import type { Envelope } from '../src/types.js';

const env = (key: string): Envelope => ({
  idempotencyKey: key,
  kind: 'usage.report',
  payload: { runId: key },
  attempts: 0,
  createdAt: 0,
});

describe('Outbox 离线发件箱', () => {
  it('在线时直接投递并清空队列', async () => {
    const sent: string[] = [];
    const box = new Outbox(new MemoryOutboxStore(), async (e) => {
      sent.push(e.idempotencyKey);
    });

    await box.enqueue(env('a'));
    await box.enqueue(env('b'));
    const r = await box.flush();

    expect(r.sent).toBe(2);
    expect(sent).toEqual(['a', 'b']);
    expect(box.pending).toBe(0);
  });

  it('断线时保留队列,重连后按原顺序补投 —— 算力上报绝不能丢', async () => {
    const store = new MemoryOutboxStore();
    let online = false;
    const sent: string[] = [];
    const box = new Outbox(store, async (e) => {
      if (!online) throw new Error('offline');
      sent.push(e.idempotencyKey);
    });

    await box.enqueue(env('a'));
    await box.enqueue(env('b'));

    await box.flush();
    expect(sent).toEqual([]);
    expect(box.pending).toBe(2); // 一条没丢

    online = true;
    const r = await box.flush();

    expect(r.sent).toBe(2);
    expect(sent).toEqual(['a', 'b']); // 顺序保住了
    expect(box.pending).toBe(0);
  });

  it('队首失败即停,不跳过它先发后面的 —— 保证服务端看到的顺序 == 产生顺序', async () => {
    const sent: string[] = [];
    const box = new Outbox(new MemoryOutboxStore(), async (e) => {
      if (e.idempotencyKey === 'a') throw new Error('boom');
      sent.push(e.idempotencyKey);
    });

    await box.enqueue(env('a'));
    await box.enqueue(env('b'));
    await box.flush();

    expect(sent).toEqual([]); // b 没有插队
    expect(box.pending).toBe(2);
  });

  it('队列跨进程重启后仍然存在(持久化)', async () => {
    const store = new MemoryOutboxStore();
    const box1 = new Outbox(store, async () => {
      throw new Error('offline');
    });
    await box1.enqueue(env('a'));
    await box1.flush();

    // 模拟客户端重启:同一个 store,全新的 Outbox
    const sent: string[] = [];
    const box2 = new Outbox(store, async (e) => {
      sent.push(e.idempotencyKey);
    });
    await box2.flush();

    expect(sent).toEqual(['a']);
  });

  it('反复失败的毒丸信封最终被丢弃,不堵死后面的', async () => {
    const dropped: Envelope[] = [];
    const sent: string[] = [];
    const box = new Outbox(
      new MemoryOutboxStore(),
      async (e) => {
        if (e.idempotencyKey === 'poison') throw new Error('永远失败');
        sent.push(e.idempotencyKey);
      },
      (e) => dropped.push(e),
    );

    await box.enqueue(env('poison'));
    await box.enqueue(env('good'));

    for (let i = 0; i < 10; i++) await box.flush();

    expect(dropped.map((d) => d.idempotencyKey)).toEqual(['poison']);
    expect(sent).toEqual(['good']); // 后面的最终发出去了
  });
});

describe('重连退避', () => {
  it('指数增长且有上限', () => {
    const max = () => 1; // random() = 1 → 取满
    expect(backoffDelay(0, max)).toBe(500);
    expect(backoffDelay(1, max)).toBe(1000);
    expect(backoffDelay(4, max)).toBe(8000);
    expect(backoffDelay(20, max)).toBe(30_000); // 封顶
  });

  it('带抖动 —— 防止服务端重启时所有客户端同时重连把它再打挂', () => {
    const rand = vi.fn().mockReturnValue(0.5);
    expect(backoffDelay(3, rand)).toBe(2000); // 0.5 * 4000
    expect(rand).toHaveBeenCalled();
  });
});
