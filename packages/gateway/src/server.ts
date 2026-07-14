import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { BillingService } from '@jin/billing';
import { extractSessionToken, type SessionResolver } from './auth.js';
import type { GatewayConfig } from './config.js';
import { handleMessages } from './routes/messages.js';
import { handleVision } from './routes/vision.js';

export interface GatewayDeps {
  config: GatewayConfig;
  billing: BillingService;
  sessions: SessionResolver;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 读图要传 base64 图片,32MB 够用

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export function createGateway(deps: GatewayDeps): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'method_not_allowed' } }));
        return;
      }

      // ① 鉴权。sessionToken ≠ 模型 key —— 它只回答「这笔算力扣谁的账」
      const token = extractSessionToken(req.headers);
      const principal = token ? await deps.sessions.resolve(token) : null;
      if (!principal) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'unauthorized', message: '无效的 session token' } }));
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'bad_request', message: String(err) } }));
        return;
      }

      // 幂等键:客户端重试带同一个 x-request-id,就不会被重复冻结/重复扣费
      const headerId = req.headers['x-request-id'];
      const requestId = (Array.isArray(headerId) ? headerId[0] : headerId) ?? randomUUID();
      const ctx = { config: deps.config, billing: deps.billing, requestId };

      try {
        if (path === '/v1/messages') {
          await handleMessages(body, principal, res, ctx);
          return;
        }
        if (path.startsWith('/vision/')) {
          await handleVision(path.slice('/vision/'.length), body, principal, res, ctx);
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found', path } }));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'internal', message: String(err) } }));
        } else {
          res.end();
        }
      }
    })();
  });
}
