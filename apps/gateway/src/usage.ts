import type { TokenUsage } from '@xiaojing/billing';

/**
 * 从上游响应里抠出真实 token 用量 —— **计费的唯一事实来源**。
 *
 * ## 为什么这个文件值得单独存在
 *
 * 摘掉 Paperclip 的 adapter 层之后,原来那条「解析 CLI stdout 拿 token」的数据链断了
 * (`packages/adapters/claude-local/src/server/parse.ts`)。现在 token 用量只能从
 * 我们网关转发的响应里读。**这里读漏了,就等于白送算力。**
 */

/** 非流式响应:usage 直接挂在 body 上。 */
export function usageFromMessage(body: unknown): TokenUsage {
  const u = (body as { usage?: Record<string, unknown> })?.usage ?? {};
  return {
    inputTokens: int(u['input_tokens']),
    cachedInputTokens: int(u['cache_read_input_tokens']),
    outputTokens: int(u['output_tokens']),
  };
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 流式(SSE)响应的用量累加器。
 *
 * ⚠️ 坑:流式下 usage **不在一个事件里**,分散在两处 ——
 *
 *   - `message_start` → `message.usage`:input_tokens / cache_read_input_tokens
 *     (以及 output_tokens 的一个**占位初值**,通常是 1~3,不是最终值)
 *   - `message_delta` → `usage`:output_tokens 的**最终值**
 *
 * 所以 output 必须**以 message_delta 为准覆盖**,不能累加、更不能只读 message_start
 * (只读前者会把几千个 output token 当成 1 个来收费)。
 *
 * Agent SDK 默认就是流式,所以这条路径才是生产主路径,不是边角情况。
 */
export class StreamUsageAccumulator {
  private input = 0;
  private cached = 0;
  private output = 0;
  private buffer = '';

  /** 喂入 SSE 原始分片(可能在任意字节处被切断)。 */
  push(chunk: string): void {
    this.buffer += chunk;
    // SSE 事件以空行分隔;最后一段可能不完整,留在 buffer 里等下一片
    const blocks = this.buffer.split('\n\n');
    this.buffer = blocks.pop() ?? '';
    for (const block of blocks) this.consumeBlock(block);
  }

  /** 流结束时把残留的最后一个事件也吃掉。 */
  flush(): void {
    if (this.buffer.trim()) this.consumeBlock(this.buffer);
    this.buffer = '';
  }

  private consumeBlock(block: string): void {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue; // 不是合法 JSON 的 data 行直接跳过,不能让计费把整个流带崩
      }

      const type = evt['type'];
      if (type === 'message_start') {
        const u = ((evt['message'] as { usage?: Record<string, unknown> })?.usage ?? {});
        this.input = int(u['input_tokens']);
        this.cached = int(u['cache_read_input_tokens']);
        this.output = int(u['output_tokens']); // 占位初值,后面会被 message_delta 覆盖
      } else if (type === 'message_delta') {
        const u = (evt['usage'] as Record<string, unknown>) ?? {};
        const out = int(u['output_tokens']);
        if (out > 0) this.output = out; // 覆盖,不累加
        // 少数实现也会在 delta 里补 input,取最大值兜底
        this.input = Math.max(this.input, int(u['input_tokens']));
        this.cached = Math.max(this.cached, int(u['cache_read_input_tokens']));
      }
    }
  }

  get usage(): TokenUsage {
    return { inputTokens: this.input, cachedInputTokens: this.cached, outputTokens: this.output };
  }
}
