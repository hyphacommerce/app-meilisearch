// The settings page's backend (design note 0029, §6.3): every call carries a session
// token the admin issued through the bridge (HS256 under the app's secret, a minute
// long, for this app), which says the store and the staff member's scopes.

import { SessionTokenError, verifySessionToken } from "@hyphacommerce/app";

import type { AppContext } from "./context.ts";
import { fromBase64Url } from "./crypto.ts";
import { all } from "./events.ts";
import { isIndexPrefix } from "./index-settings.ts";
import { stringField } from "./json.ts";
import { appSecret, meiliFor } from "./installations.ts";
import { APP_KEY } from "./manifest.ts";
import { MeiliClient, MeiliError } from "./meili.ts";
import type { InstallationRow } from "./storage.ts";

/** Reading and changing search settings is how products are presented (0019, §6). */
export const SETTINGS_SCOPE = "products:read";

export class SettingsError extends Error {
  readonly status: 401 | 403 | 404 | 422;
  readonly code: string;
  constructor(status: SettingsError["status"], code: string, message: string) {
    super(message);
    this.name = "SettingsError";
    this.status = status;
    this.code = code;
  }
}

/** The installation a session token is for, once its signature and claims check out. */
export async function authenticate(
  ctx: AppContext,
  authorization: string | null | undefined,
): Promise<InstallationRow> {
  const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
  if (!token) throw new SettingsError(401, "unauthenticated", "a session token is required");
  // The store claim picks the secret; the signature then proves the claim.
  let store: string | undefined;
  try {
    const payload: unknown = JSON.parse(
      new TextDecoder().decode(fromBase64Url(token.split(".")[1] ?? "")),
    );
    store = stringField(payload, "store");
  } catch {
    store = undefined;
  }
  const row = store ? await ctx.storage.getInstallation(store) : undefined;
  if (!row) throw new SettingsError(401, "invalid_token", "no installation for this token");
  try {
    const claims = await verifySessionToken(token, await appSecret(ctx, row), {
      audience: APP_KEY,
      now: Math.floor(ctx.now() / 1000),
    });
    if (!claims.scopes.includes(SETTINGS_SCOPE))
      throw new SettingsError(403, "insufficient_scope", `needs ${SETTINGS_SCOPE}`);
  } catch (error) {
    if (error instanceof SessionTokenError)
      throw new SettingsError(401, "invalid_token", error.message);
    throw error;
  }
  return row;
}

export interface SettingsView {
  store: string;
  meilisearch_url: string | null;
  has_api_key: boolean;
  index_prefix: string;
  status: {
    queued: number;
    ready: boolean;
    last_reindex_at: string | null;
    last_error: string | null;
    indexes: { market: string; uid: string; documents: number | null }[];
  };
}

export async function view(ctx: AppContext, row: InstallationRow): Promise<SettingsView> {
  const meili = await meiliFor(ctx, row, 3_000).catch(() => undefined);
  const indexes = await Promise.all(
    (await ctx.storage.indexes(row.store)).map(async (index) => ({
      market: index.market,
      uid: index.uid,
      documents: meili
        ? ((await meili.stats(index.uid).catch(() => undefined))?.numberOfDocuments ?? null)
        : null,
    })),
  );
  return {
    store: row.store,
    meilisearch_url: row.meili_url,
    has_api_key: row.meili_key !== null,
    index_prefix: row.index_prefix,
    status: {
      queued: await ctx.storage.countMarks(row.store),
      ready: row.last_reindex_at !== null,
      last_reindex_at: row.last_reindex_at ? new Date(row.last_reindex_at).toISOString() : null,
      last_error: row.last_error,
      indexes,
    },
  };
}

export interface SettingsInput {
  meilisearch_url?: unknown;
  /** Absent or empty keeps the stored key. */
  api_key?: unknown;
  index_prefix?: unknown;
}

/** Saves the settings after checking Meilisearch answers with the key. */
export async function save(
  ctx: AppContext,
  row: InstallationRow,
  input: SettingsInput,
): Promise<InstallationRow> {
  const rawUrl = typeof input.meilisearch_url === "string" ? input.meilisearch_url.trim() : "";
  let url: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
    url = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch {
    throw new SettingsError(422, "invalid_url", "the Meilisearch URL must be an http(s) URL");
  }
  const prefix =
    typeof input.index_prefix === "string" && input.index_prefix.trim() !== ""
      ? input.index_prefix.trim()
      : "hypha";
  if (!isIndexPrefix(prefix))
    throw new SettingsError(
      422,
      "invalid_prefix",
      "the index prefix is 1 to 40 lowercase letters, digits, - or _, starting with a letter",
    );
  const newKey = typeof input.api_key === "string" ? input.api_key.trim() : "";
  const key =
    newKey !== ""
      ? newKey
      : row.meili_key
        ? await ctx.vault.open(row.meili_key, `${row.store}:meili_key`)
        : "";
  if (key === "") throw new SettingsError(422, "missing_key", "the admin API key is required");

  try {
    await new MeiliClient({ url, apiKey: key, fetch: ctx.fetch, timeoutMs: 5_000 }).version();
  } catch (error) {
    const reason = error instanceof MeiliError ? error.message : String(error);
    throw new SettingsError(422, "meilisearch_unreachable", `Meilisearch refused: ${reason}`);
  }

  const moved = url !== row.meili_url || prefix !== row.index_prefix;
  await ctx.storage.updateInstallation(row.store, {
    meili_url: url,
    meili_key: await ctx.vault.seal(key, `${row.store}:meili_key`),
    index_prefix: prefix,
    updated_at: ctx.now(),
    ...(moved ? { caches_ready: 0, last_reindex_at: null, last_error: null } : {}),
  });
  if (moved) {
    // New indexes: build them all.
    await ctx.storage.clearIndexes(row.store);
    await ctx.storage.mark(row.store, [all()], ctx.now());
  }
  const saved = await ctx.storage.getInstallation(row.store);
  if (!saved) throw new SettingsError(404, "not_installed", "the app was uninstalled meanwhile");
  return saved;
}

/** Queues a rebuild of everything. */
export async function reindex(ctx: AppContext, row: InstallationRow): Promise<void> {
  await ctx.storage.mark(row.store, [all()], ctx.now());
}
