import { createBillingRuntime } from './billing.js';
import { InMemorySessionResolver } from './auth.js';
import { loadConfig } from './config.js';
import { createGateway } from './server.js';
import { registerCoverFont } from './vision/compose-cover.js';

const config = loadConfig();
registerCoverFont(config.coverFontPath);

// 真金白银走 Postgres:重启后余额和冻结都还在,孤儿冻结在启动时被回收(见 billing.ts)
const runtime = await createBillingRuntime({ databaseUrl: config.databaseUrl });
// TODO(JIN-49 合仓后):换成 Paperclip 的 session 表
const sessions = new InMemorySessionResolver();

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
