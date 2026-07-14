/**
 * 小镜 客户端 ↔ 服务端(Paperclip fork)通信协议。
 *
 * 三条通道,职责不重叠:
 *   1. HTTP  /api/*            —— 认证、任务同步、算力上报(请求-响应)
 *   2. WS    /api/realtime     —— 消息推送(服务端 → 客户端)
 *   3. HTTP  /api/gateway/v1/* —— 模型网关(Anthropic 兼容;服务端持 key)
 *
 * 关键安全约束:客户端只持有 sessionToken(可撤销、短期)。模型厂商的 key
 * 只存在于服务端网关。客户端把 sessionToken 当作 x-api-key 发给我们的网关,
 * 网关校验后换成真 key 转发给 GLM。见 docs/desktop/architecture.md。
 */

/** 服务端签发的会话凭证。这不是模型 key —— 客户端永远拿不到模型 key。 */
export interface SessionCredentials {
  sessionToken: string;
  /** Unix ms。客户端在过期前主动 refresh。 */
  expiresAt: number;
  userId: string;
  workspaceId: string;
  /** 模型网关的 base URL,形如 https://api.xiaojing.ai/api/gateway/v1 */
  gatewayBaseUrl: string;
}

export interface DeviceIdentity {
  deviceId: string;
  platform: 'win32' | 'darwin' | 'linux';
  appVersion: string;
}

/** 一次 agent 运行的算力消耗。按 1M token = 5 元计价(服务端配置项)。 */
export interface UsageReport {
  runId: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** 客户端本地时间戳 (Unix ms)。服务端以自己的时钟为准计费。 */
  clientTs: number;
}

/** 服务端 → 客户端 的实时推送。 */
export type ServerPush =
  | { type: 'message.created'; conversationId: string; message: unknown }
  | { type: 'task.updated'; taskId: string; status: string }
  | { type: 'agent.invoke'; runId: string; agentId: string; prompt: string; conversationId: string }
  | { type: 'session.revoked'; reason: string }
  | { type: 'ping'; ts: number };

/** 客户端 → 服务端 的出站信封。离线时进队列,重连后按序重放。 */
export interface Envelope<T = unknown> {
  /** 客户端生成的幂等键。服务端必须按此去重 —— 重连重放会重发。 */
  idempotencyKey: string;
  kind: 'usage.report' | 'message.send' | 'task.update' | 'agent.result';
  payload: T;
  /** 已尝试投递次数,用于退避与毒丸检测。 */
  attempts: number;
  createdAt: number;
}

export interface TransportState {
  status: 'offline' | 'connecting' | 'online';
  /** 队列中待投递的信封数 —— UI 上显示"N 条待同步"。 */
  pending: number;
  lastError?: string;
}
