import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb } from "../src/client.js";
import { heartbeatRuns } from "../src/schema/index.js";

// Ground-truth reader for the核心闭环 E2E (JIN-88).
//
// 派活(assign an issue to a hired 员工)在服务端会走 queueIssueAssignmentWakeup →
// heartbeat.wakeup → INSERT heartbeat_runs(invocation_source='assignment')。E2E 断言
// 「被指派人真出 heartbeat_runs 行」时不许用 mock 顶——直接把真实的 DB 行读出来。
//
// Usage: tsx read-heartbeat-runs.ts --config <path> --company <uuid> --agent <uuid> [--source assignment]
// Prints one JSON line: {"count": N, "rows": [{id, invocationSource, status}, ...]}

function readArg(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function resolveDbUrl(configPath: string) {
  const config = JSON.parse(readFileSync(path.resolve(configPath), "utf8")) as {
    database?: { mode?: string; embeddedPostgresPort?: number; connectionString?: string };
  };
  return config.database?.mode === "postgres"
    ? config.database.connectionString
    : `postgres://paperclip:paperclip@127.0.0.1:${config.database?.embeddedPostgresPort ?? 54329}/paperclip`;
}

async function main() {
  const configPath = readArg("--config");
  const companyId = readArg("--company");
  const agentId = readArg("--agent");
  const source = readArg("--source");

  if (!configPath || !companyId || !agentId) {
    throw new Error("Usage: tsx read-heartbeat-runs.ts --config <path> --company <uuid> --agent <uuid> [--source <invocation_source>]");
  }

  const dbUrl = resolveDbUrl(configPath);
  if (!dbUrl) throw new Error(`Could not resolve database connection from ${configPath}`);

  const db = createDb(dbUrl);
  const closableDb = db as typeof db & { $client?: { end?: (options?: { timeout?: number }) => Promise<void> } };

  try {
    const filters = [eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)];
    if (source) filters.push(eq(heartbeatRuns.invocationSource, source));

    const rows = await db
      .select({
        id: heartbeatRuns.id,
        invocationSource: heartbeatRuns.invocationSource,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(and(...filters));

    process.stdout.write(`${JSON.stringify({ count: rows.length, rows })}\n`);
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
