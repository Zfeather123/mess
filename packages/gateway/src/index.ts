import { createBillingRuntime } from './billing.js';
import { loadConfig } from './config.js';
import { PgSessionResolver } from './pg-session-resolver.js';
import { createGateway } from './server.js';
import { registerCoverFont } from './vision/compose-cover.js';

const config = loadConfig();
registerCoverFont(config.coverFontPath);

// 真金白银走 Postgres:重启后余额和冻结都还在,孤儿冻结在启动时被回收(见 billing.ts)
const runtime = await createBillingRuntime({ databaseUrl: config.databaseUrl });

// 鉴权也走 Postgres(复用同一个连接池)。
// **这里没有 fallback,故意的**:库连不上就让进程起不来。计费回落内存 = 无声丢钱,
// 鉴权回落内存 = 无声放行 —— 后者更严重。宁可起不来。
const sessions = new PgSessionResolver(runtime.db);

const server = createGateway({ config, billing: runtime.billing, sessions }).listen(config.port, () => {
  console.log(`[gateway] :${config.port} → ${config.anthropicBaseUrl}`);
});

// 停机前把 sweeper 和连接池收干净。收不干净不影响正确性(下一个进程启动时会对账),
// 但会让被 kill 的部署留下一批本可以立刻回收的冻结。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    void runtime.stop().finally(() => process.exit(0));
  });
}
