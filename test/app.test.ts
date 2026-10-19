import assert from "node:assert/strict";
import { test } from "node:test";

import { signRequest, signSessionToken } from "@hypha/app";

import { createApp } from "../src/core/app.ts";
import { APP_KEY, SCOPES } from "../src/core/manifest.ts";
import { API, MEILI, SECRET, STORE, type Route, get, harness, install } from "./harness.ts";

async function sessionToken(scope = "products:read", secret = SECRET, aud = APP_KEY) {
  const now = Math.floor(Date.parse("2026-10-19T12:00:00Z") / 1000);
  return signSessionToken(
    { iss: API, aud, sub: "user_1", store: STORE, scope, iat: now, exp: now + 60, jti: "j" },
    secret,
  );
}

const meiliOk: Route = (_request, url) =>
  url.origin === MEILI ? Response.json({ pkgVersion: "1.54.3", results: [] }) : undefined;

test("the manifest names the app's scopes, webhooks, point and settings page", async () => {
  const { ctx } = await harness();
  const response = await createApp(ctx).request("/manifest.json");
  const manifest = (await response.json()) as Record<string, unknown>;
  assert.equal(manifest.key, "app_meilisearch");
  assert.deepEqual(manifest.scopes, [...SCOPES]);
  assert.ok(!(manifest.scopes as string[]).some((s) => s.startsWith("customer_data:")));
  assert.deepEqual(manifest.extension_points, [
    { point: "search.query", version: 1, url: "/hypha/extensions" },
  ]);
  assert.deepEqual(manifest.redirect_uris, ["http://app.test/hypha/oauth/callback"]);
});

test("install: /install starts OAuth with PKCE, the callback stores the installation", async () => {
  let tokenRequest: URLSearchParams | undefined;
  const oauth: Route[] = [
    async (request, url) => {
      if (url.pathname !== "/oauth/token") return undefined;
      tokenRequest = new URLSearchParams(await request.text());
      return Response.json({
        access_token: "hypha_at_1",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "hypha_rt_1",
        scope: SCOPES.join(" "),
        app_secret: SECRET,
      });
    },
    get("/admin/store", { id: STORE, name: "Shop" }),
    get("/admin/app-extensions/origins", { origins: ["http://admin.test"] }),
  ];
  const { ctx } = await harness(oauth);
  const app = createApp(ctx);

  const start = await app.request(`/install?api=${encodeURIComponent(API)}`);
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location") ?? "");
  assert.equal(authorize.origin + authorize.pathname, `${API}/oauth/authorize`);
  assert.equal(authorize.searchParams.get("client_id"), "http://app.test/manifest.json");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("scope"), SCOPES.join(" "));
  const state = authorize.searchParams.get("state") ?? "";

  const done = await app.request(`/hypha/oauth/callback?code=hypha_ac_1&state=${state}`);
  assert.equal(done.status, 200);
  assert.match(tokenRequest?.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43}$/);
  const row = await ctx.storage.getInstallation(STORE);
  assert.ok(row);
  assert.equal(row.api_url, API);
  assert.equal(await ctx.vault.open(row.app_secret, `${STORE}:app_secret`), SECRET);
  assert.notEqual(row.access_token, "hypha_at_1");
  assert.deepEqual(JSON.parse(row.admin_origins), ["http://admin.test"]);

  // The state is single use.
  const replay = await app.request(`/hypha/oauth/callback?code=hypha_ac_1&state=${state}`);
  assert.equal(replay.status, 400);
});

test("install refuses an API outside the allow-list", async () => {
  const { ctx } = await harness();
  ctx.config.apiUrls = ["https://api.shop.example"];
  const response = await createApp(ctx).request(`/install?api=${encodeURIComponent(API)}`);
  assert.equal(response.status, 400);
});

test("settings need a session token for this app with products:read", async () => {
  const { ctx } = await harness([meiliOk]);
  await install(ctx);
  const app = createApp(ctx);
  const call = (token?: string) =>
    app.request("/api/settings", token ? { headers: { authorization: `Bearer ${token}` } } : {});
  assert.equal((await call()).status, 401);
  assert.equal((await call(await sessionToken("products:read", "other"))).status, 401);
  assert.equal((await call(await sessionToken("products:read", SECRET, "app_other"))).status, 401);
  assert.equal((await call(await sessionToken("orders:read"))).status, 403);
  const ok = await call(await sessionToken());
  assert.equal(ok.status, 200);
  const view = (await ok.json()) as Record<string, unknown>;
  assert.equal(view.meilisearch_url, MEILI);
  assert.equal(view.has_api_key, true);
  assert.ok(!JSON.stringify(view).includes("meili-key"));
});

test("saving settings checks Meilisearch, seals the key and queues a full build", async () => {
  const { ctx } = await harness([meiliOk]);
  await install(ctx, { meili_url: null, meili_key: null });
  const app = createApp(ctx);
  const token = await sessionToken();
  const put = (body: unknown) =>
    app.request("/api/settings", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await put({ meilisearch_url: "ftp://x", api_key: "k" })).status, 422);
  assert.equal((await put({ meilisearch_url: MEILI })).status, 422);
  assert.equal(
    (await put({ meilisearch_url: MEILI, api_key: "k", index_prefix: "Bad Prefix" })).status,
    422,
  );
  const saved = await put({
    meilisearch_url: `${MEILI}/`,
    api_key: "new-key",
    index_prefix: "shop",
  });
  assert.equal(saved.status, 200);
  const row = await ctx.storage.getInstallation(STORE);
  assert.equal(row?.meili_url, MEILI);
  assert.equal(row?.index_prefix, "shop");
  assert.equal(await ctx.vault.open(row?.meili_key ?? "", `${STORE}:meili_key`), "new-key");
  // Queued (a background step may already hold it).
  assert.equal(await ctx.storage.countMarks(STORE, [0, 0]), 1);

  const reindex = await app.request("/api/reindex", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(reindex.status, 202);
});

test("the settings page may be framed only by the stores' admins", async () => {
  const { ctx } = await harness();
  await install(ctx);
  const response = await createApp(ctx).request("/settings");
  assert.equal(
    response.headers.get("content-security-policy"),
    "frame-ancestors http://admin.test",
  );
  assert.match(await response.text(), /"origins":\["http:\/\/admin.test"\]/);
});

async function extensionCall(body: unknown, { secret = SECRET, store = STORE } = {}) {
  const raw = JSON.stringify(body);
  return new Request("http://app.test/hypha/extensions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "hypha-signature": await signRequest(secret, raw),
      "hypha-extension": "search.query",
      "hypha-extension-version": "1",
      "idempotency-key": "search_1",
      "hypha-store": store,
    },
    body: raw,
  });
}

const query = {
  query: "shirt",
  market: "mkt_00000000000000000000000000000001",
  currency: "EUR",
  sort: "relevance",
  group: "listing",
  offset: 0,
  limit: 2,
  facets: ["vendor"],
};

test("search.query: signed by the store's secret, answered from its market's index", async () => {
  let asked: unknown;
  const meili: Route = async (request, url) => {
    if (url.origin !== MEILI) return undefined;
    asked = await request.json();
    return Response.json({
      results: [
        {
          indexUid: "x",
          hits: [
            { product: "prod_1", variant: "var_1" },
            { product: "prod_2", variant: "var_2" },
          ],
        },
        { indexUid: "x", hits: [], totalHits: 7, facetDistribution: { vendor: { Loom: 4 } } },
      ],
    });
  };
  const { ctx } = await harness([meili]);
  await install(ctx, { caches_ready: 1, last_reindex_at: 1 });
  await ctx.storage.saveIndex(STORE, { market: query.market, uid: "u", settings_hash: "h" });
  const app = createApp(ctx);

  const response = await app.request(await extensionCall(query));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    hits: [
      { product: "prod_1", variant: "var_1" },
      { product: "prod_2", variant: "var_2" },
    ],
    total: 7,
    facets: [{ facet: "vendor", values: [{ value: "Loom", count: 4 }] }],
  });
  const queries = (asked as { queries: { indexUid: string }[] }).queries;
  assert.equal(queries[0]?.indexUid, `hypha_${STORE}_${query.market}`);

  assert.equal((await app.request(await extensionCall(query, { secret: "other" }))).status, 401);
});

test("search.query before the first full build fails, so Hypha falls back", async () => {
  const { ctx } = await harness();
  await install(ctx);
  const response = await createApp(ctx).request(await extensionCall(query));
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as { code: string }).code, "not_ready");
});
