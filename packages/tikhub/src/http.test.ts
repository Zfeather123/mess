import { describe, expect, it } from "vitest";
import { RateLimiter, backoffDelay, type Clock } from "./http.js";

/** 虚拟时钟:sleep 直接推进时间,用例不真的等。 */
function virtualClock(): Clock & { time: () => number } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    time: () => t,
  };
}

describe("backoffDelay(指数退避 + 满抖动)", () => {
  it("上界随尝试次数指数增长", () => {
    // random=1 → 取到上界
    expect(backoffDelay(0, () => 0.999999)).toBeLessThan(500);
    expect(backoffDelay(1, () => 0.999999)).toBeLessThan(1000);
    expect(backoffDelay(2, () => 0.999999)).toBeLessThan(2000);
  });

  it("满抖动:random=0 时为 0", () => {
    expect(backoffDelay(5, () => 0)).toBe(0);
  });

  it("封顶 30s", () => {
    expect(backoffDelay(50, () => 0.999999)).toBeLessThanOrEqual(30_000);
  });
});

describe("RateLimiter(封顶 10 QPS)", () => {
  it("任意 1 秒窗口内放行不超过 10 次", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter(10, clock);
    const stamps: number[] = [];

    for (let i = 0; i < 35; i++) {
      await limiter.acquire();
      stamps.push(clock.now());
    }

    // 对每个放行时刻,统计它之后 1 秒(不含)内的放行数量 —— 不得超过 10。
    for (let i = 0; i < stamps.length; i++) {
      const windowCount = stamps.filter((t) => t >= stamps[i]! && t - stamps[i]! < 1000).length;
      expect(windowCount).toBeLessThanOrEqual(10);
    }
    // 35 次 @10QPS 至少要跨过 3 秒。
    expect(clock.now()).toBeGreaterThanOrEqual(3000);
  });

  it("未顶到上限时不引入等待", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter(10, clock);

    for (let i = 0; i < 10; i++) await limiter.acquire();

    expect(clock.now()).toBe(0);
  });

  it("并发调用也会串行排队,不会一起冲过限流", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter(10, clock);

    await Promise.all(Array.from({ length: 25 }, () => limiter.acquire()));

    // 25 次 @10QPS → 至少跨 2 秒
    expect(clock.now()).toBeGreaterThanOrEqual(2000);
  });
});
