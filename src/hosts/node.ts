// The Node host: the core on `@hono/node-server`, SQLite (`node:sqlite`) for storage,
// and an interval that works due marks (as a Worker's cron does).
//
//   APP_URL=http://localhost:8787 APP_ENCRYPTION_KEY=$(openssl rand -hex 32) node src/hosts/node.ts

import { serve } from "@hono/node-server";

import { createApp } from "../core/app.ts";
import { type AppContext, configFromEnv } from "../core/context.ts";
import { Vault } from "../core/crypto.ts";
import { runDue } from "../core/indexer.ts";
import { migrate } from "../core/sql.ts";
import { SqlStorage } from "../core/storage.ts";
import { sqliteDb } from "./sqlite.ts";

const env = process.env;
const config = configFromEnv(env);
const db = sqliteDb(env.DATABASE_PATH ?? "meilisearch-app.sqlite");
await migrate(db);

const log = (message: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...fields }));

const ctx: AppContext = {
  config,
  storage: new SqlStorage(db),
  vault: new Vault(env.APP_ENCRYPTION_KEY ?? ""),
  fetch: (input, init) => globalThis.fetch(input, init),
  now: Date.now,
  background: (work) => {
    work.catch((error: unknown) => log("background work failed", { error: String(error) }));
  },
  log,
};

const app = createApp(ctx);
const port = Number(env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port, hostname: env.HOST ?? "0.0.0.0" }, (info) =>
  log("listening", { port: info.port, app_url: config.appUrl }),
);

// Due work every few seconds; one run at a time.
const interval = Number(env.RUN_INTERVAL_MS ?? 2_000);
let running = false;
const timer = setInterval(() => {
  if (running) return;
  running = true;
  runDue(ctx, Date.now() + 30_000)
    .then(() => ctx.storage.prune(Date.now() - 7 * 24 * 3_600_000))
    .catch((error: unknown) => log("runner failed", { error: String(error) }))
    .finally(() => {
      running = false;
    });
}, interval);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
