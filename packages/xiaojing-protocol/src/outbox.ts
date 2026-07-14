import type { Envelope } from './types.js';

/**
 * 离线发件箱:断线时把出站信封持久化,重连后按 FIFO 重放。
 *
 * 为什么需要:算力上报(usage.report)绝不能丢 —— 丢了就是我们白送算力。
 * 用户在地铁里断网,agent 仍在本地跑完一整轮,产生的 token 消耗必须补报。
 *
 * 幂等由 idempotencyKey 保证:重放可能重复投递(我们发出去了但没收到 ack),
 * 服务端按 key 去重。宁可重发,不可丢。
 */

export interface OutboxStore {
  load(): Promise<Envelope[]>;
  save(items: Envelope[]): Promise<void>;
}

/** 内存实现 —— 测试用。生产用 FileOutboxStore(见 apps/desktop)。 */
export class MemoryOutboxStore implements OutboxStore {
  private items: Envelope[] = [];
  async load() {
    return [...this.items];
  }
  async save(items: Envelope[]) {
    this.items = [...items];
  }
}

export type Sender = (e: Envelope) => Promise<void>;

/** 超过这个尝试次数仍失败的信封视为毒丸,移出队列避免堵死后面的。 */
const MAX_ATTEMPTS = 8;

export class Outbox {
  private queue: Envelope[] = [];
  private flushing = false;
  private loaded = false;

  constructor(
    private readonly store: OutboxStore,
    private readonly send: Sender,
    private readonly onDropped?: (e: Envelope, err: unknown) => void,
  ) {}

  private async ensureLoaded() {
    if (!this.loaded) {
      this.queue = await this.store.load();
      this.loaded = true;
    }
  }

  get pending() {
    return this.queue.length;
  }

  /** 入队并持久化。调用方不 await flush —— 投递是尽力而为的后台行为。 */
  async enqueue(e: Envelope): Promise<void> {
    await this.ensureLoaded();
    this.queue.push(e);
    await this.store.save(this.queue);
  }

  /**
   * 尝试投递队首直到队列空或某一条失败。
   * 严格 FIFO 且失败即停 —— 保证服务端看到的顺序 == 客户端产生的顺序。
   */
  async flush(): Promise<{ sent: number; failed: number }> {
    if (this.flushing) return { sent: 0, failed: 0 };
    this.flushing = true;
    await this.ensureLoaded();
    let sent = 0;
    let failed = 0;
    try {
      while (this.queue.length > 0) {
        const head = this.queue[0]!;
        try {
          await this.send(head);
          this.queue.shift();
          sent++;
          await this.store.save(this.queue);
        } catch (err) {
          head.attempts++;
          failed++;
          if (head.attempts >= MAX_ATTEMPTS) {
            this.queue.shift();
            this.onDropped?.(head, err);
          }
          await this.store.save(this.queue);
          break; // 失败即停:后面的还得排队,保住顺序
        }
      }
    } finally {
      this.flushing = false;
    }
    return { sent, failed };
  }
}
