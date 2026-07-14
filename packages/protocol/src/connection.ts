import type { ServerPush, TransportState } from './types.js';

/**
 * 实时通道:带指数退避 + 抖动的重连。
 *
 * 抖动是必需的,不是可选的:桌面客户端会成千上万台同时在线,服务端一重启,
 * 所有客户端会在同一毫秒重连,把刚起来的服务端再打挂(惊群)。抖动把重连
 * 打散开。
 */

export interface SocketLike {
  send(data: string): void;
  close(): void;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onopen: (() => void) | null;
}

export type SocketFactory = (url: string, token: string) => SocketLike;

export interface ConnectionOptions {
  url: string;
  token: string;
  connect: SocketFactory;
  onPush: (p: ServerPush) => void;
  onState: (s: TransportState) => void;
  /** 连上后触发,用于 flush 离线发件箱。 */
  onOnline?: () => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/** 指数退避 + 满抖动 (full jitter),上限 30s。 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.floor(random() * exp);
}

export class RealtimeConnection {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private stopped = false;
  private pending = 0;

  constructor(private readonly opts: ConnectionOptions) {}

  setPending(n: number) {
    this.pending = n;
  }

  private emit(status: TransportState['status'], lastError?: string) {
    this.opts.onState({ status, pending: this.pending, lastError });
  }

  async start(): Promise<void> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const random = this.opts.random ?? Math.random;

    while (!this.stopped) {
      this.emit('connecting');
      try {
        await this.once();
        // 正常关闭也要重连 —— 但先把 attempt 归零,因为这次是连上过的
        this.attempt = 0;
      } catch (err) {
        this.emit('offline', err instanceof Error ? err.message : String(err));
        this.attempt++;
      }
      if (this.stopped) break;
      await sleep(backoffDelay(this.attempt, random));
    }
  }

  /** 建立一次连接,直到它关闭。连上时 resolve/reject 由 onclose 驱动。 */
  private once(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      const sock = this.opts.connect(this.opts.url, this.opts.token);
      this.socket = sock;

      sock.onopen = () => {
        opened = true;
        this.attempt = 0;
        this.emit('online');
        this.opts.onOnline?.();
      };
      sock.onmessage = (data) => {
        try {
          this.opts.onPush(JSON.parse(data) as ServerPush);
        } catch {
          // 单条坏消息不该拆掉整条连接
        }
      };
      sock.onclose = () => {
        this.socket = null;
        this.emit('offline');
        if (opened) resolve();
        else reject(new Error('connection closed before open'));
      };
    });
  }

  stop() {
    this.stopped = true;
    this.socket?.close();
  }
}
