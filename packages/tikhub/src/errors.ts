import type { TikHubErrorCode } from "./types.js";

/**
 * 哪些错误值得重试。
 *
 * 铁律:401(没授权)/ 402(余额不足)/ invalid_input **永不重试** ——
 * 重试它们不可能成功,而 402 每次调用都是**真金白银**(TikHub 按次计费)。
 */
const RETRYABLE: ReadonlySet<TikHubErrorCode> = new Set<TikHubErrorCode>([
  "rate_limited",
  "upstream_error",
  "network_error",
]);

export class TikHubError extends Error {
  readonly code: TikHubErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    code: TikHubErrorCode,
    message: string,
    opts: { status?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "TikHubError";
    this.code = code;
    this.status = opts.status;
    this.retryable = RETRYABLE.has(code);
  }
}

/**
 * HTTP 状态码 → 错误码。
 * TikHub 文档明确:401 未授权 / 402 余额不足 / 429 触发限流。
 */
export function errorCodeForStatus(status: number): TikHubErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 402) return "insufficient_balance";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 500) return "upstream_error";
  // 400/422 等 —— 参数错误,重试没有意义。
  return "invalid_input";
}
