import { TikHubError, errorCodeForStatus } from "./errors.js";

/**
 * 这个包自带的极简 HTTP 层。
 *
 * 为什么不复用共享 http client:本仓库**没有**共享的 http client —— 每个外部集成
 * 都各自搓了一个 fetchWithTimeout。这里也一样,但把三件事做对:
 *   1. 超时(默认 30s,AbortController)
 *   2. 只对可重试错误做「指数退避 + 满抖动」重试(最多 3 次)
 *   3. 客户端侧限流,封顶 10 QPS(TikHub 官方上限)
 */

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

/**
 * 指数退避 + 满抖动 (full jitter),上限 30s。
 *
 * ⚠️ 这是 packages/xiaojing-protocol/src/connection.ts 里 `backoffDelay` 的**镜像**,
 * 不是第 4 个变体。之所以复制而不是 import:xiaojing-protocol 是桌面端实时连接协议包,
 * 让服务端的数据抓取包去依赖它,依赖方向是反的(server → desktop protocol),
 * 而且会往 workspace 里加一条本不需要的边。逻辑必须与那边保持一致 —— 改一处要改两处。
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.floor(random() * exp);
}

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * 滑动窗口限流器:任意 1 秒窗口内,放行的请求数不超过 `maxQps`。
 *
 * 用滑动窗口而不是「每次 sleep 1/qps」:后者在突发之后会白白拖慢串行调用,
 * 而滑动窗口只在真的顶到上限时才等。
 *
 * 串行化 acquire():并发调用者会排队,避免多个协程同时看到「还有额度」而一起冲过去。
 */
export class RateLimiter {
  private readonly recent: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxQps: number,
    private readonly clock: Clock = realClock,
  ) {}

  /** 拿到放行许可后才返回。 */
  acquire(): Promise<void> {
    const next = this.tail.then(() => this.acquireOne());
    // 吞掉异常,避免一个失败的等待毒化整条队列。
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async acquireOne(): Promise<void> {
    if (this.maxQps <= 0) return;
    for (;;) {
      const now = this.clock.now();
      // 丢掉 1 秒窗口以外的记录。
      while (this.recent.length > 0 && now - this.recent[0]! >= 1000) this.recent.shift();

      if (this.recent.length < this.maxQps) {
        this.recent.push(now);
        return;
      }
      // 窗口满了 —— 等到最早那次调用滑出窗口。
      const waitMs = 1000 - (now - this.recent[0]!);
      await this.clock.sleep(Math.max(waitMs, 1));
    }
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxAttempts: number;
  maxQps: number;
  fetch: typeof globalThis.fetch;
  clock: Clock;
  random?: () => number;
}

/** TikHub 的响应信封:`data` 是抖音原始对象的无类型透传。 */
export interface TikHubEnvelope {
  code?: number;
  router?: string;
  params?: unknown;
  data?: unknown;
}

export class TikHubHttp {
  private readonly limiter: RateLimiter;

  constructor(private readonly opts: HttpClientOptions) {
    this.limiter = new RateLimiter(opts.maxQps, opts.clock);
  }

  get(path: string, query: Record<string, string | number | undefined>): Promise<TikHubEnvelope> {
    const url = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    return this.request(url.toString(), { method: "GET" });
  }

  post(path: string, body: unknown): Promise<TikHubEnvelope> {
    const url = new URL(path, this.opts.baseUrl);
    return this.request(url.toString(), {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
  }

  private async request(url: string, init: RequestInit): Promise<TikHubEnvelope> {
    const { maxAttempts, random = Math.random, clock } = this.opts;
    let lastError: TikHubError | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.limiter.acquire();
      try {
        return await this.attempt(url, init);
      } catch (err) {
        const e =
          err instanceof TikHubError
            ? err
            : new TikHubError("network_error", `[tikhub] 请求失败: ${String(err)}`, { cause: err });
        // 401 / 402 / invalid_input 永不重试 —— 重试不可能成功,402 还要多花钱。
        if (!e.retryable || attempt === maxAttempts - 1) throw e;
        lastError = e;
        await clock.sleep(backoffDelay(attempt, random));
      }
    }
    /* c8 ignore next */
    throw lastError ?? new TikHubError("network_error", "[tikhub] 重试耗尽");
  }

  private async attempt(url: string, init: RequestInit): Promise<TikHubEnvelope> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          // TikHub 认证:Bearer token。
          Authorization: `Bearer ${this.opts.apiKey}`,
          accept: "application/json",
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      // 网络错误 / abort 超时 —— 可重试。
      throw new TikHubError("network_error", `[tikhub] 网络错误: ${String(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const code = errorCodeForStatus(res.status);
      const body = await safeText(res);
      throw new TikHubError(code, `[tikhub] HTTP ${res.status}: ${body.slice(0, 300)}`, {
        status: res.status,
      });
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new TikHubError("upstream_error", "[tikhub] 响应不是合法 JSON", { cause: err });
    }
    if (json === null || typeof json !== "object") {
      throw new TikHubError("upstream_error", "[tikhub] 响应信封不是对象");
    }
    return json as TikHubEnvelope;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
