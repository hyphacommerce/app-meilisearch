// The app's routes, on Hono over Web APIs only, so the Workers and Node hosts serve the
// same thing (`src/hosts/`).

import { ExtensionError, OAuthError, defineExtensionHandler, extensionHandler } from "@hypha/app";
import { Hono } from "hono";

import { SETTINGS_CLIENT_JS } from "../ui/generated/settings-client.ts";
import type { AppContext } from "./context.ts";
import { indexName } from "./index-settings.ts";
import { runDue } from "./indexer.ts";
import {
  InstallError,
  appSecret,
  checkApiUrl,
  completeInstall,
  meiliFor,
  startInstall,
} from "./installations.ts";
import { PATHS, manifest } from "./manifest.ts";
import { isRecord } from "./json.ts";
import { MeiliError } from "./meili.ts";
import { landingPage, messagePage, privacyPage, settingsPage } from "./pages.ts";
import { search } from "./query.ts";
import { SettingsError, authenticate, reindex, save, view } from "./settings.ts";
import { webhooks } from "./webhooks.ts";

/** How long a kicked runner may work (a Worker's `waitUntil` lasts 30 s after the response). */
const KICK_BUDGET_MS = 20_000;

/** Runs due work in the background, one runner at a time per process or isolate. */
export function kicker(ctx: AppContext): () => void {
  let running = false;
  let again = false;
  const run = async () => {
    running = true;
    try {
      do {
        again = false;
        await runDue(ctx, ctx.now() + KICK_BUDGET_MS);
      } while (again);
    } finally {
      running = false;
    }
  };
  return () => {
    if (running) {
      again = true;
      return;
    }
    ctx.background(run());
  };
}

/** The `search.query` handler: Hypha falls back to its own engine on any error. */
export function searchHandler(ctx: AppContext) {
  return defineExtensionHandler("search.query", async (body, call) => {
    const row = call.store ? await ctx.storage.getInstallation(call.store) : undefined;
    if (!row) throw new ExtensionError("not_installed", "no installation for this store", 404);
    const meili = await meiliFor(ctx, row, ctx.config.searchTimeoutMs);
    if (!meili || row.last_reindex_at === null)
      throw new ExtensionError("not_ready", "the index hasn't been built yet", 503);
    const known = await ctx.storage.indexes(row.store);
    if (!known.some((i) => i.market === body.market))
      throw new ExtensionError("not_ready", `no index for ${body.market} yet`, 503);
    try {
      return await search(
        meili,
        indexName(row.index_prefix, row.store, body.market),
        body,
        ctx.config.searchTimeoutMs,
      );
    } catch (error) {
      if (error instanceof MeiliError)
        throw new ExtensionError("search_unavailable", error.message, 502);
      throw error;
    }
  });
}

/** The origins allowed to frame the settings page. */
async function frameOrigins(ctx: AppContext): Promise<string[]> {
  const origins = new Set(ctx.config.adminOrigins);
  for (const row of await ctx.storage.listInstallations()) {
    try {
      const listed: unknown = JSON.parse(row.admin_origins);
      if (Array.isArray(listed))
        for (const origin of listed as unknown[])
          if (typeof origin === "string") origins.add(origin);
    } catch {
      // A row written by hand: its origins are ignored.
    }
  }
  return [...origins].toSorted();
}

export function createApp(ctx: AppContext) {
  const app = new Hono();
  const kick = kicker(ctx);

  const extensions = extensionHandler({
    // `Hypha-Store` picks the installation; its secret must sign the call.
    secret: async ({ store }) => {
      const row = store ? await ctx.storage.getInstallation(store) : undefined;
      return row ? appSecret(ctx, row) : undefined;
    },
    handlers: [searchHandler(ctx)],
    onError: (error, call) =>
      ctx.log("extension handler failed", {
        point: call.point,
        store: call.store,
        error: String(error),
      }),
  });

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/", (c) => c.html(landingPage(ctx.config.appUrl)));
  app.get(PATHS.privacy, (c) => c.html(privacyPage()));
  app.get(PATHS.manifest, (c) =>
    c.json(manifest(ctx.config.appUrl), 200, { "cache-control": "no-store" }),
  );

  // The convention every admin's "Install app" uses: `GET <app_url>/install?api=<API>`.
  app.get(PATHS.install, async (c) => {
    try {
      const api = checkApiUrl(ctx, c.req.query("api"));
      return c.redirect(await startInstall(ctx, api), 302);
    } catch (error) {
      if (error instanceof InstallError)
        return c.html(messagePage("Can't install", error.message), 400);
      throw error;
    }
  });

  app.get(PATHS.callback, async (c) => {
    try {
      const store = await completeInstall(ctx, c.req.url);
      kick();
      return c.html(
        messagePage(
          "Meilisearch is installed",
          `Installed for ${store}. Open Settings → Meilisearch in your admin to connect your Meilisearch.`,
        ),
      );
    } catch (error) {
      if (error instanceof InstallError || error instanceof OAuthError) {
        ctx.log("install failed", { error: error.message });
        return c.html(messagePage("Installation failed", error.message), 400);
      }
      throw error;
    }
  });

  const webhook = webhooks(ctx, { onMarked: () => kick() });
  app.post(PATHS.webhooks, (c) => webhook(c.req.raw));

  app.post(PATHS.extensions, (c) => extensions(c.req.raw));

  app.get(PATHS.settings, async (c) => {
    const origins = await frameOrigins(ctx);
    return c.html(settingsPage(origins), 200, {
      "content-security-policy": `frame-ancestors ${origins.length > 0 ? origins.join(" ") : "'none'"}`,
      "cache-control": "no-store",
    });
  });
  app.get("/settings.js", (c) =>
    c.body(SETTINGS_CLIENT_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );

  app.get("/api/settings", async (c) => {
    const row = await authenticate(ctx, c.req.header("authorization"));
    return c.json(await view(ctx, row));
  });
  app.put("/api/settings", async (c) => {
    const row = await authenticate(ctx, c.req.header("authorization"));
    const body: unknown = await c.req.json().catch(() => ({}));
    const input = isRecord(body) ? body : {};
    const saved = await save(ctx, row, input);
    kick();
    return c.json(await view(ctx, saved));
  });
  app.post("/api/reindex", async (c) => {
    const row = await authenticate(ctx, c.req.header("authorization"));
    await reindex(ctx, row);
    kick();
    return c.json({ queued: true }, 202);
  });

  app.onError((error, c) => {
    if (error instanceof SettingsError)
      return c.json({ code: error.code, error: error.message }, error.status);
    ctx.log("request failed", { path: c.req.path, error: String(error) });
    return c.json({ code: "internal", error: "something went wrong" }, 500);
  });

  return app;
}
