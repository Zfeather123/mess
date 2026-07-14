import { BillingService, InMemoryCreditLedger } from '@xiaojing/billing';
import { InMemorySessionResolver } from './auth.js';
import { loadConfig } from './config.js';
import { createGateway } from './server.js';
import { registerCoverFont } from './vision/compose-cover.js';

const config = loadConfig();
registerCoverFont(config.coverFontPath);

// TODO(JIN-49 合仓后):换成 Paperclip 的 session 表 + SQL 账本(schema.ts 已给出建表)
const billing = new BillingService(new InMemoryCreditLedger());
const sessions = new InMemorySessionResolver();

createGateway({ config, billing, sessions }).listen(config.port, () => {
  console.log(`[gateway] :${config.port} → ${config.anthropicBaseUrl}`);
});
