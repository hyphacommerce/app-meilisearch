// The end-to-end steps against a running Hypha, this app and Meilisearch (started by
// scripts/e2e.sh, which passes their addresses). Each step asserts and stops at the
// first failure.

import assert from "node:assert/strict";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const HYPHA = env("HYPHA_URL");
const APP = env("APP_URL");
const MEILI = env("MEILI_URL");
const MEILI_KEY = env("MEILI_KEY");
const STOREFRONT_KEY = env("STOREFRONT_KEY");
const APP_KEY = "app_meilisearch";

let session = "";

function step(name: string) {
  console.log(`-- ${name}`);
}

async function json(response: Response, what: string): Promise<any> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const admin = async (method: string, path: string, body?: unknown) =>
  json(
    await fetch(`${HYPHA}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${session}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    `${method} ${path}`,
  );

const storefront = async (query: string) =>
  json(
    await fetch(`${HYPHA}/storefront/search?${query}`, {
      headers: { "x-publishable-key": STOREFRONT_KEY },
    }),
    `search ${query}`,
  );

const meili = async (method: string, path: string, body?: unknown) =>
  json(
    await fetch(`${MEILI}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${MEILI_KEY}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    `meili ${path}`,
  );

/** The app's settings API, as the settings page calls it: a fresh session token each time. */
async function app(method: string, path: string, body?: unknown) {
  const { token } = await admin("POST", `/admin/app-extensions/${APP_KEY}/session`);
  return json(
    await fetch(`${APP}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    `app ${method} ${path}`,
  );
}

async function until<T>(what: string, check: () => Promise<T | undefined>, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function meiliIdle() {
  await until("Meilisearch's tasks", async () => {
    const tasks = await meili("GET", "/tasks?statuses=enqueued,processing&limit=1");
    return tasks.total === 0 ? true : undefined;
  });
}

/** The parts of a search answer the app decides: which hits, in which order, the counts. */
function shape(result: any) {
  return {
    items: result.items.map((i: any) => `${i.product}/${i.variant}`),
    total: result.total,
    facets: result.facets.map((f: any) => ({
      key: f.key,
      values: f.values.map((v: any) => `${v.value}:${v.count}`),
    })),
  };
}

step("log in as the owner");
const login = await json(
  await fetch(`${HYPHA}/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: env("OWNER_EMAIL"), password: env("OWNER_PASSWORD") }),
  }),
  "login",
);
assert.equal(login.status, "authenticated");
session = login.session.token;

step("install: GET /install?api= starts OAuth on Hypha");
const install = await fetch(`${APP}/install?api=${encodeURIComponent(HYPHA)}`, {
  redirect: "manual",
});
assert.equal(install.status, 302);
const authorize = install.headers.get("location") ?? "";
assert.ok(authorize.startsWith(`${HYPHA}/oauth/authorize?`), authorize);
const toConsent = await fetch(authorize, { redirect: "manual" });
assert.ok(
  [302, 303].includes(toConsent.status),
  `authorize: ${toConsent.status} ${await toConsent.clone().text()}`,
);
const consent = new URL(toConsent.headers.get("location") ?? "");
assert.equal(consent.pathname, "/apps/consent");
const requestId = consent.searchParams.get("request") ?? "";

step("the owner reads the consent request and approves it");
const pending = await admin("GET", `/admin/oauth/requests/${requestId}`);
console.log(`   ${JSON.stringify(pending).slice(0, 300)}`);
const approved = await admin("POST", `/admin/oauth/requests/${requestId}/approve`);
const callback = await fetch(approved.redirect_to);
assert.equal(callback.status, 200, await callback.clone().text());

step("the app is installed with its grant");
const installed = await admin("GET", `/admin/apps/${APP_KEY}`);
console.log(`   grant: ${JSON.stringify(installed.grant?.scopes ?? installed.grant)}`);

step("settings through a session token: connect Meilisearch");
const saved = await app("PUT", "/api/settings", {
  meilisearch_url: MEILI,
  api_key: MEILI_KEY,
  index_prefix: "e2e",
});
assert.equal(saved.has_api_key, true);

step("the full index is built");
const built = await until("the full index", async () => {
  const view = await app("GET", "/api/settings");
  if (view.status.last_error) console.log(`   (last error: ${view.status.last_error})`);
  return view.status.ready && view.status.queued === 0 ? view : undefined;
});
await meiliIdle();
const indexes = await app("GET", "/api/settings");
for (const index of indexes.status.indexes)
  console.log(`   ${index.uid}: ${index.documents} documents`);
const total = indexes.status.indexes.reduce((n: number, i: any) => n + (i.documents ?? 0), 0);
const status = await admin("GET", "/admin/search/status");
// Hypha's own engine holds the same documents: one per variant per market.
assert.equal(total, status.documents, "the app's documents and Hypha's own");
assert.ok(built.status.indexes.length >= 1);

const queries = [
  "country=DE&sort=newest&limit=24",
  "country=DE&sort=price_asc&limit=10&group=product",
  "country=DE&sort=price_desc&group=variant&limit=30",
  "country=DE&sort=title&filter=option.color:Black&filter=option.color:White",
  "country=GB&sort=newest&available=true&filter=vendor:Lumen%20%26%20Loom",
  "country=US&sort=price_asc&price_min=2000&price_max=8000",
];

step("Hypha's built-in engine first (the reference)");
const builtIn = new Map<string, unknown>();
for (const query of queries) builtIn.set(query, shape(await storefront(query)));
const callsBefore = (await admin("GET", `/admin/apps/${APP_KEY}/extension-calls?limit=100`)).items
  .length;

step("the store's search app: app_meilisearch");
const settings = await admin("PATCH", "/admin/search/settings", { search_app: APP_KEY });
assert.equal(settings.search_app, APP_KEY);

step("/storefront/search is answered by the app, as the built-in engine answers");
for (const query of queries) {
  const answer = shape(await storefront(query));
  assert.deepEqual(answer, builtIn.get(query), `search ${query}`);
  console.log(`   ${query}: ${answer.total} hits, same as built in`);
}
const words = await storefront("country=DE&q=linen&limit=5");
console.log(`   q=linen: ${words.total} hits`);

const calls = (await admin("GET", `/admin/apps/${APP_KEY}/extension-calls?limit=100`)).items;
const searchCalls = calls.filter((c: any) => c.point === "search.query");
console.log(
  `   extension calls: ${searchCalls.map((c: any) => `${c.outcome}/${c.duration_ms}ms`).join(", ")}`,
);
assert.equal(searchCalls.length - callsBefore, queries.length + 1);
assert.ok(
  searchCalls.every((c: any) => c.outcome === "ok"),
  JSON.stringify(searchCalls),
);

step("a product update reaches the index by webhook");
const products = await admin("GET", "/admin/products?limit=1&status=active");
const product = products.items[0];
const title = `Meilisearch Kettlebell ${Date.now()}`;
await admin("PATCH", `/admin/products/${product.id}`, { title });
const market = indexes.status.indexes[0].uid;
await until("the new title in Meilisearch", async () => {
  const found = await meili("POST", `/indexes/${market}/search`, {
    q: "",
    filter: [`product = "${product.id}"`],
    limit: 1,
  });
  return found.hits[0]?.title === title ? true : undefined;
});
const kettle = await until("the storefront to find it", async () => {
  const found = await storefront("country=DE&q=kettlebell");
  return found.items.some((i: any) => i.product === product.id) ? found : undefined;
});
assert.equal(kettle.items[0].title, title);
const deliveries = await admin("GET", `/admin/apps/${APP_KEY}/deliveries?limit=20`);
console.log(
  `   deliveries: ${deliveries.items
    .slice(0, 5)
    .map((d: any) => `${d.event_type ?? d.type ?? "?"}:${d.status}`)
    .join(", ")}`,
);
const last = (await admin("GET", `/admin/apps/${APP_KEY}/extension-calls?limit=1`)).items[0];
assert.equal(last.point, "search.query");
assert.equal(last.outcome, "ok");

console.log("\nend to end: ok");
