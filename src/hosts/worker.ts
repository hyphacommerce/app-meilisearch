// The Workers host: the core on D1, `waitUntil` for work after a response, and a cron
// trigger for due marks. With `HYPHA_API` bound (a Service Binding to Hypha's API Worker,
// design note 0029, §9) and `HYPHA_API_URL` set, calls to the API go through the binding.

import type {
  D1Database,
  ExecutionContext,
  Fetcher,
  ScheduledController,
} from "@cloudflare/workers-types/index.ts";

import { createApp } from "../core/app.ts";
import { type AppContext, configFromEnv } from "../core/context.ts";
import { Vault } from "../core/crypto.ts";
import { runDue } from "../core/indexer.ts";
import { migrate } from "../core/sql.ts";
import { SqlStorage } from "../core/storage.ts";
import { d1Db } from "./d1.ts";

interface Env {
  DB: D1Database;
  APP_URL: string;
  APP_ENCRYPTION_KEY: string;
  HYPHA_API_URLS?: string;
  ADMIN_ORIGINS?: string;
  REINDEX_BATCH?: string;
  SEARCH_TIMEOUT_MS?: string;
  HYPHA_API_URL?: string;
  HYPHA_API?: Fetcher;
}

const log = (message: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ message, ...fields }));

let migrated: Promise<unknown> | undefined;

function context(env: Env, waitUntil: (work: Promise<unknown>) => void): AppContext {
  const db = d1Db(env.DB);
  const binding = env.HYPHA_API;
  const apiOrigin = env.HYPHA_API_URL ? new URL(env.HYPHA_API_URL).origin : undefined;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (binding && apiOrigin && new URL(request.url).origin === apiOrigin)
      // Workers' own Request and Response types: the same objects at runtime.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the runtime's types
      return binding.fetch(request as never) as unknown as Promise<Response>;
    return globalThis.fetch(request);
  };
  return {
    config: configFromEnv({
      APP_URL: env.APP_URL,
      HYPHA_API_URLS: env.HYPHA_API_URLS,
      ADMIN_ORIGINS: env.ADMIN_ORIGINS,
      REINDEX_BATCH: env.REINDEX_BATCH,
      SEARCH_TIMEOUT_MS: env.SEARCH_TIMEOUT_MS,
    }),
    storage: new SqlStorage(db),
    vault: new Vault(env.APP_ENCRYPTION_KEY),
    fetch,
    now: Date.now,
    background: (work) =>
      waitUntil(
        work.catch((error: unknown) => log("background work failed", { error: String(error) })),
      ),
    log,
  };
}

async function ready(env: Env) {
  migrated ??= migrate(d1Db(env.DB)).catch((error: unknown) => {
    migrated = undefined;
    throw error;
  });
  await migrated;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await ready(env);
    const app = createApp(context(env, (work) => ctx.waitUntil(work)));
    return app.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    await ready(env);
    const app = context(env, (work) => ctx.waitUntil(work));
    await runDue(app, Date.now() + 25_000);
    await app.storage.prune(Date.now() - 7 * 24 * 3_600_000);
  },
};
