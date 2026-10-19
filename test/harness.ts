// A context on in-memory SQLite, with `fetch` routed to fakes of Hypha's admin API and
// Meilisearch.

import type { AppContext } from "../src/core/context.ts";
import { DEFAULT_CONFIG } from "../src/core/context.ts";
import { Vault } from "../src/core/crypto.ts";
import { migrate } from "../src/core/sql.ts";
import { type InstallationRow, SqlStorage } from "../src/core/storage.ts";
import { sqliteDb } from "../src/hosts/sqlite.ts";

export const KEY = "00".repeat(32);
export const API = "http://hypha.test";
export const MEILI = "http://meili.test";
export const STORE = "store_00000000000000000000000000000007";
export const SECRET = "hypha_as_test_secret";

export type Route = (
  request: Request,
  url: URL,
) => Response | undefined | Promise<Response | undefined>;

export async function harness(routes: Route[] = []) {
  const db = sqliteDb(":memory:");
  await migrate(db);
  const requests: Request[] = [];
  const background: Promise<unknown>[] = [];
  let now = Date.parse("2026-10-19T12:00:00Z");
  const ctx: AppContext = {
    config: { ...DEFAULT_CONFIG, appUrl: "http://app.test" },
    storage: new SqlStorage(db),
    vault: new Vault(KEY),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      const url = new URL(request.url);
      for (const route of routes) {
        const answer = await route(request, url);
        if (answer) return answer;
      }
      return Response.json(
        { code: "not_found", error: `no fake for ${url.pathname}` },
        { status: 404 },
      );
    },
    now: () => now,
    background: (work) => {
      background.push(work);
    },
    log: () => {},
  };
  return {
    ctx,
    db,
    requests,
    background,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** An installation as `completeInstall` leaves it, Meilisearch configured. */
export async function install(
  ctx: AppContext,
  fields: Partial<InstallationRow> = {},
): Promise<InstallationRow> {
  const now = ctx.now();
  const row: InstallationRow = {
    store: STORE,
    api_url: API,
    scopes: "products:read markets:read pricing:read inventory:read channels:read",
    access_token: await ctx.vault.seal("hypha_at_x", `${STORE}:access_token`),
    refresh_token: await ctx.vault.seal("hypha_rt_x", `${STORE}:refresh_token`),
    expires_at: now + 3_600_000,
    app_secret: await ctx.vault.seal(SECRET, `${STORE}:app_secret`),
    admin_origins: JSON.stringify(["http://admin.test"]),
    meili_url: MEILI,
    meili_key: await ctx.vault.seal("meili-key", `${STORE}:meili_key`),
    index_prefix: "hypha",
    caches_ready: 0,
    last_reindex_at: null,
    last_error: null,
    refresh_lock_until: 0,
    installed_at: now,
    updated_at: now,
    ...fields,
  };
  await ctx.storage.saveInstallation(row);
  return row;
}

/** `GET path` answered with `body`. */
export function get(path: string | RegExp, body: unknown): Route {
  return (request, url) => {
    if (request.method !== "GET") return undefined;
    const matches = typeof path === "string" ? url.pathname === path : path.test(url.pathname);
    if (!matches) return undefined;
    return Response.json(typeof body === "function" ? (body as (url: URL) => unknown)(url) : body);
  };
}
