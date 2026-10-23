// Installing (design note 0029, §4.1): `GET /install?api=<Hypha API>` starts OAuth with
// PKCE (the verifier kept here, keyed by `state`), Hypha's admin asks a staff member to
// approve, and the redirect's code is exchanged for tokens and, on first install, the
// app's secret. Each installation is keyed by its store's ID, which the token response
// names (`store`, as webhooks and extension calls name it in `Hypha-Store`).

import {
  HyphaClient,
  type TokenSet,
  type TokenStore,
  createAuthorizationUrl,
  exchangeCode,
  memoryTokenStore,
  parseAuthorizationResponse,
} from "@hyphacommerce/app";

import type { AppContext } from "./context.ts";
import { HyphaReader } from "./hypha.ts";
import { PATHS, SCOPES } from "./manifest.ts";
import { MeiliClient } from "./meili.ts";
import type { InstallationRow } from "./storage.ts";

/** An authorization older than this is refused (Hypha's requests last 10 minutes). */
const STATE_TTL_MS = 15 * 60_000;
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;
/** How long a refresh may hold the lock before another process may take it. */
const REFRESH_LOCK_MS = 30_000;
/** How long to wait for another process's refresh, and how often to look. */
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 200;

export class InstallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InstallError";
    this.code = code;
  }
}

export const manifestUrl = (ctx: AppContext) => `${ctx.config.appUrl}${PATHS.manifest}`;
const redirectUri = (ctx: AppContext) => `${ctx.config.appUrl}${PATHS.callback}`;

/** The API's base URL from `?api=`, if it's one the app may be installed from. */
export function checkApiUrl(ctx: AppContext, raw: string | null | undefined): string {
  let url: URL;
  try {
    url = new URL(raw ?? "");
  } catch {
    throw new InstallError("invalid_api_url", "`api` must be the Hypha API's base URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new InstallError("invalid_api_url", "`api` must be an http(s) URL");
  if (ctx.config.apiUrls.length > 0 && !ctx.config.apiUrls.includes(url.origin))
    throw new InstallError("api_not_allowed", `this app isn't offered to ${url.origin}`);
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Where to send the browser to authorize the app on `apiUrl`. */
export async function startInstall(ctx: AppContext, apiUrl: string): Promise<string> {
  const request = await createAuthorizationUrl({
    apiUrl,
    manifestUrl: manifestUrl(ctx),
    redirectUri: redirectUri(ctx),
    scopes: SCOPES,
  });
  await ctx.storage.saveOAuthState({
    state: request.state,
    api_url: apiUrl,
    code_verifier: request.codeVerifier,
    created_at: ctx.now(),
  });
  return request.url;
}

/** Finishes an install from the redirect's URL; answers the store's ID. */
export async function completeInstall(ctx: AppContext, callback: string): Promise<string> {
  const response = parseAuthorizationResponse(callback);
  if (!response.ok) {
    if (response.state) await ctx.storage.takeOAuthState(response.state);
    throw new InstallError(response.error, response.description ?? "the authorization was refused");
  }
  const state = await ctx.storage.takeOAuthState(response.state);
  if (!state || ctx.now() - state.created_at > STATE_TTL_MS)
    throw new InstallError("invalid_state", "this authorization expired or was already used");

  const tokens = await exchangeCode({
    apiUrl: state.api_url,
    manifestUrl: manifestUrl(ctx),
    code: response.code,
    codeVerifier: state.code_verifier,
    redirectUri: redirectUri(ctx),
    fetch: ctx.fetch,
    now: ctx.now,
  });
  const store = tokens.store;
  const reader = new HyphaReader(
    new HyphaClient({
      apiUrl: state.api_url,
      manifestUrl: manifestUrl(ctx),
      tokens: memoryTokenStore(tokens),
      fetch: ctx.fetch,
      now: ctx.now,
    }),
  );
  const existing = await ctx.storage.getInstallation(store);
  const sealedSecret = tokens.appSecret
    ? await ctx.vault.seal(tokens.appSecret, `${store}:app_secret`)
    : existing?.app_secret;
  if (!sealedSecret)
    throw new InstallError(
      "no_app_secret",
      "Hypha sent no app secret and none is stored: rotate it in the admin (POST /admin/apps/app_meilisearch/secret) and install again",
    );
  // Saved before anything else is read: Hypha sends `app.installed` (signed with the
  // secret) as soon as the code is exchanged, and a delivery that finds no installation
  // is refused and retried.
  const now = ctx.now();
  await ctx.storage.saveInstallation({
    store,
    api_url: state.api_url,
    scopes: tokens.scopes.join(" "),
    access_token: await ctx.vault.seal(tokens.accessToken, `${store}:access_token`),
    refresh_token: await ctx.vault.seal(tokens.refreshToken, `${store}:refresh_token`),
    expires_at: tokens.expiresAt,
    app_secret: sealedSecret,
    admin_origins: existing?.admin_origins ?? "[]",
    meili_url: existing?.meili_url ?? null,
    meili_key: existing?.meili_key ?? null,
    index_prefix: existing?.index_prefix ?? "hypha",
    caches_ready: 0,
    last_reindex_at: existing?.last_reindex_at ?? null,
    last_error: null,
    refresh_lock_until: 0,
    installed_at: existing?.installed_at ?? now,
    updated_at: now,
  });
  // Build everything once Meilisearch is configured (the runner waits for it).
  await ctx.storage.mark(store, [{ target: "all", priority: 0 }], now);
  const origins = await reader.adminOrigins().catch((): string[] | undefined => undefined);
  if (origins)
    await ctx.storage.updateInstallation(store, {
      admin_origins: JSON.stringify(origins),
      updated_at: ctx.now(),
    });
  return store;
}

export async function appSecret(ctx: AppContext, row: InstallationRow): Promise<string> {
  return ctx.vault.open(row.app_secret, `${row.store}:app_secret`);
}

/** The installation's Meilisearch, `undefined` until its settings are saved. */
export async function meiliFor(
  ctx: AppContext,
  row: InstallationRow,
  timeoutMs?: number,
): Promise<MeiliClient | undefined> {
  if (!row.meili_url || !row.meili_key) return undefined;
  return new MeiliClient({
    url: row.meili_url,
    apiKey: await ctx.vault.open(row.meili_key, `${row.store}:meili_key`),
    fetch: ctx.fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function readTokens(ctx: AppContext, row: InstallationRow): Promise<TokenSet> {
  return {
    accessToken: await ctx.vault.open(row.access_token, `${row.store}:access_token`),
    refreshToken: await ctx.vault.open(row.refresh_token, `${row.store}:refresh_token`),
    expiresAt: row.expires_at,
    scopes: row.scopes.split(" ").filter(Boolean),
    store: row.store,
    // The API the app was installed from: where it calls and refreshes.
    issuer: row.api_url,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The installation's tokens in the app's database. Refresh tokens rotate and a reused
 * one revokes the grant, so `HyphaClient` refreshes inside `withLock`, here a lock on
 * the installation's row (`refresh_lock_until`): two isolates or processes never refresh
 * at once, and the one that waited reads the pair the other stored.
 */
export function tokenStore(ctx: AppContext, store: string): TokenStore {
  return {
    get: async () => {
      const row = await ctx.storage.getInstallation(store);
      return row ? readTokens(ctx, row) : undefined;
    },
    set: async (tokens) => {
      await ctx.storage.updateInstallation(store, {
        access_token: await ctx.vault.seal(tokens.accessToken, `${store}:access_token`),
        refresh_token: await ctx.vault.seal(tokens.refreshToken, `${store}:refresh_token`),
        expires_at: tokens.expiresAt,
        scopes: tokens.scopes.join(" "),
        updated_at: ctx.now(),
      });
    },
    async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      const deadline = ctx.now() + LOCK_WAIT_MS;
      for (;;) {
        const now = ctx.now();
        if (await ctx.storage.tryLockRefresh(store, now, now + REFRESH_LOCK_MS)) break;
        if (now >= deadline)
          throw new Error(`another process is refreshing ${store}'s tokens; try again`);
        await sleep(LOCK_POLL_MS);
      }
      try {
        return await fn();
      } finally {
        await ctx.storage.unlockRefresh(store);
      }
    },
  };
}

/** The admin API as the installation's app; its token refreshes under the row's lock. */
export function readerFor(ctx: AppContext, row: InstallationRow): HyphaReader {
  const client = new HyphaClient({
    apiUrl: row.api_url,
    manifestUrl: manifestUrl(ctx),
    tokens: tokenStore(ctx, row.store),
    fetch: ctx.fetch,
    now: ctx.now,
    refreshMarginMs: REFRESH_MARGIN_MS,
  });
  return new HyphaReader(client);
}
