// What every part of the app is given by its host: configuration, storage, the vault,
// `fetch`, a clock, and a way to keep work going after a response (`waitUntil` on
// Workers, a detached promise on Node).

import type { Vault } from "./crypto.ts";
import type { Storage } from "./storage.ts";

export interface AppConfig {
  /** Where the app is served, without a trailing `/`: its manifest is `<appUrl>/manifest.json`. */
  appUrl: string;
  /** Hypha APIs allowed to install the app (origins); empty allows any. */
  apiUrls: string[];
  /** Admin origins allowed to frame the settings page, besides each store's own. */
  adminOrigins: string[];
  /** Products rebuilt per step. */
  batch: number;
  /** How long a step holds its marks, in milliseconds. */
  leaseMs: number;
  /** Timeout of a search's Meilisearch calls (Hypha waits 3 s for `search.query`). */
  searchTimeoutMs: number;
}

export const DEFAULT_CONFIG: Omit<AppConfig, "appUrl"> = {
  apiUrls: [],
  adminOrigins: [],
  batch: 20,
  leaseMs: 120_000,
  searchTimeoutMs: 1_200,
};

export interface AppContext {
  config: AppConfig;
  storage: Storage;
  vault: Vault;
  fetch: typeof globalThis.fetch;
  now: () => number;
  /** Runs `work` after the response; errors are the host's to log. */
  background: (work: Promise<unknown>) => void;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const number = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Reads the configuration from a host's environment variables. */
export function configFromEnv(env: Record<string, string | undefined>): AppConfig {
  const appUrl = env.APP_URL?.replace(/\/+$/, "");
  if (!appUrl) throw new Error("APP_URL is required (where the app is served)");
  return {
    appUrl,
    apiUrls: list(env.HYPHA_API_URLS).map((u) => new URL(u).origin),
    adminOrigins: list(env.ADMIN_ORIGINS).map((u) => new URL(u).origin),
    batch: number(env.REINDEX_BATCH, DEFAULT_CONFIG.batch),
    leaseMs: DEFAULT_CONFIG.leaseMs,
    searchTimeoutMs: number(env.SEARCH_TIMEOUT_MS, DEFAULT_CONFIG.searchTimeoutMs),
  };
}
