import assert from "node:assert/strict";
import { test } from "node:test";

import type { SearchDocument } from "../src/core/documents.ts";
import { step } from "../src/core/indexer.ts";
import { MEILI, STORE, type Route, get, harness, install } from "./harness.ts";
import {
  CATALOG_EU,
  CATALOG_UK,
  LIST_UK,
  LOCATION_EU,
  LOCATION_UK,
  MARKET_EU,
  MARKET_UK,
  catalogue,
  id,
  item,
  stockLocation,
} from "./fixtures.ts";

/** Hypha's admin API over the fixture catalogue: EU sells everything, UK the mug. */
function fakeHypha(products = catalogue()): Route[] {
  return [
    get("/admin/markets", {
      items: [
        {
          id: MARKET_EU,
          name: "EU",
          currency: "EUR",
          catalog: CATALOG_EU,
          countries: ["DE"],
          prices_include_tax: true,
        },
        {
          id: MARKET_UK,
          name: "UK",
          currency: "GBP",
          catalog: CATALOG_UK,
          countries: ["GB"],
          prices_include_tax: true,
        },
      ],
    }),
    get(`/admin/catalogs/${CATALOG_EU}`, { id: CATALOG_EU, market: MARKET_EU, price_list: null }),
    get(`/admin/catalogs/${CATALOG_UK}`, {
      id: CATALOG_UK,
      market: MARKET_UK,
      price_list: LIST_UK,
    }),
    get("/admin/price-lists", { items: [{ id: LIST_UK, currency: "GBP", adjustment_bps: 0 }] }),
    get("/admin/locations", {
      items: [stockLocation(LOCATION_EU, [MARKET_EU]), stockLocation(LOCATION_UK, [MARKET_UK])],
    }),
    get("/admin/categories", { items: [] }),
    get("/admin/search/settings", { facets: [], split_by: [], search_app: "app_meilisearch" }),
    get(`/admin/catalogs/${CATALOG_EU}/products`, (url: URL) =>
      // Two pages, to follow the cursor.
      url.searchParams.get("cursor")
        ? {
            items: products.slice(2).map((p) => ({ id: p.id })),
            has_more: false,
            next_cursor: null,
          }
        : {
            items: products.slice(0, 2).map((p) => ({ id: p.id })),
            has_more: true,
            next_cursor: "c2",
          },
    ),
    get(`/admin/catalogs/${CATALOG_UK}/products`, {
      items: [{ id: id("prod", 2) }],
      has_more: false,
    }),
    get(`/admin/price-lists/${LIST_UK}/fixed-prices`, {
      items: [{ variant: id("var", 21), price: { amount: 1300, currency: "GBP" } }],
      has_more: false,
    }),
    get("/admin/products", {
      items: products.map((p) => ({ id: p.id })),
      has_more: false,
      next_cursor: null,
    }),
    get(/^\/admin\/products\/prod_[0-9a-f]+\/inventory$/, (url: URL) => {
      const product = url.pathname.split("/")[3];
      return {
        items:
          product === id("prod", 1)
            ? [item(11, [[LOCATION_EU, 2]]), item(12, [[LOCATION_EU, 0]])]
            : [],
      };
    }),
    (request, url) => {
      const match = /^\/admin\/products\/(prod_[0-9a-f]+)$/.exec(url.pathname);
      if (request.method !== "GET" || !match) return undefined;
      const found = products.find((p) => p.id === match[1]);
      return found
        ? Response.json(found)
        : Response.json({ code: "product_not_found" }, { status: 404 });
    },
  ];
}

interface MeiliCall {
  method: string;
  path: string;
  body: unknown;
}

/** Records Meilisearch's writes and answers them as enqueued tasks. */
function fakeMeili(calls: MeiliCall[]): Route {
  return async (request, url) => {
    if (url.origin !== MEILI) return undefined;
    const text = await request.text();
    calls.push({
      method: request.method,
      path: url.pathname,
      body: text ? JSON.parse(text) : undefined,
    });
    return Response.json(
      { taskUid: calls.length, indexUid: null, status: "enqueued", type: "x" },
      { status: 202 },
    );
  };
}

const failing: Route = (_request, url) =>
  url.origin === MEILI
    ? Response.json({ message: "boom", code: "internal" }, { status: 500 })
    : undefined;

const uid = (market: string) => `hypha_${STORE}_${market}`;

test("a full build: caches, every product found, documents per market, stale ones removed", async () => {
  const calls: MeiliCall[] = [];
  const { ctx } = await harness([fakeMeili(calls), ...fakeHypha()]);
  await install(ctx);
  await ctx.storage.mark(STORE, [{ target: "all", priority: 0 }], ctx.now());

  const steps: string[] = [];
  for (let i = 0; i < 10; i++) {
    const result = await step(ctx, STORE);
    steps.push(result.did);
    if (!result.more) break;
  }
  assert.deepEqual(steps, ["caches", "expanded", "products"]);

  // Both indexes got their settings before any document.
  assert.deepEqual(
    calls.filter((c) => c.path.endsWith("/settings")).map((c) => c.path),
    [`/indexes/${uid(MARKET_EU)}/settings`, `/indexes/${uid(MARKET_UK)}/settings`],
  );
  const added = (market: string) =>
    calls
      .filter((c) => c.path === `/indexes/${uid(market)}/documents`)
      .flatMap((c) => c.body as SearchDocument[]);
  assert.deepEqual(
    added(MARKET_EU).map((d) => [d.id, d.price, d.available]),
    [
      [id("var", 11), 4000, true],
      [id("var", 12), 4200, false],
      [id("var", 13), 3800, true],
      [id("var", 21), 1500, true],
    ],
  );
  // The UK catalog has the mug at its fixed price; the shirt isn't sold there.
  assert.deepEqual(
    added(MARKET_UK).map((d) => [d.id, d.price, d.currency]),
    [[id("var", 21), 1300, "GBP"]],
  );
  const deletes = calls.filter((c) => c.path === `/indexes/${uid(MARKET_UK)}/documents/delete`);
  assert.deepEqual(
    deletes.map((c) => c.body),
    [
      {
        filter: `product = "${id("prod", 1)}" OR (product = "${id("prod", 2)}" AND variant NOT IN ["${id("var", 21)}"]) OR product = "${id("prod", 3)}"`,
      },
    ],
  );

  const row = await ctx.storage.getInstallation(STORE);
  assert.equal(row?.caches_ready, 1);
  assert.equal(row?.last_reindex_at, ctx.now());
  assert.equal(await ctx.storage.countMarks(STORE), 0);
  // Variants are known, so a stock event finds its product.
  assert.deepEqual(await ctx.storage.productsOfVariants(STORE, [id("var", 12)]), [id("prod", 1)]);
});

test("a stock change rebuilds just its product", async () => {
  const calls: MeiliCall[] = [];
  const { ctx } = await harness([fakeMeili(calls), ...fakeHypha()]);
  await install(ctx, { caches_ready: 1, last_reindex_at: 1 });
  await ctx.storage.setVariants(STORE, id("prod", 2), [id("var", 21)]);
  await ctx.storage.replaceCatalogProducts(STORE, CATALOG_EU, [id("prod", 2)]);
  await ctx.storage.mark(STORE, [{ target: `variant:${id("var", 21)}`, priority: 1 }], ctx.now());

  assert.equal((await step(ctx, STORE)).did, "expanded");
  assert.equal((await step(ctx, STORE)).did, "products");
  assert.equal((await step(ctx, STORE)).more, false);
  const documents = calls
    .filter((c) => c.path.endsWith("/documents"))
    .flatMap((c) => c.body as SearchDocument[]);
  assert.deepEqual(
    documents.map((d) => d.product),
    [id("prod", 2)],
  );
});

test("products wait for the caches, and nothing runs before Meilisearch is set", async () => {
  const calls: MeiliCall[] = [];
  const { ctx } = await harness([fakeMeili(calls), ...fakeHypha()]);
  await install(ctx, { meili_url: null, meili_key: null });
  await ctx.storage.mark(STORE, [{ target: `product:${id("prod", 1)}`, priority: 4 }], ctx.now());
  assert.equal((await step(ctx, STORE)).did, "not_configured");

  await install(ctx, { caches_ready: 0 });
  // Caches not ready: everything is rebuilt first.
  const first = await step(ctx, STORE);
  assert.equal(first.more, true);
  assert.equal((await step(ctx, STORE)).did, "caches");
});

test("a failing Meilisearch leaves the marks for a later step and records the error", async () => {
  const { ctx, advance } = await harness([failing, ...fakeHypha()]);
  await install(ctx, { caches_ready: 1 });
  await ctx.storage.mark(STORE, [{ target: `product:${id("prod", 1)}`, priority: 4 }], ctx.now());
  const result = await step(ctx, STORE);
  assert.equal(result.did, "failed");
  assert.equal((await ctx.storage.getInstallation(STORE))?.last_error, "boom");
  assert.equal(await ctx.storage.countMarks(STORE), 1);
  // Still leased now; due again once the lease runs out.
  assert.deepEqual(await ctx.storage.storesWithDueMarks(ctx.now()), []);
  advance(ctx.config.leaseMs + 1);
  assert.deepEqual(await ctx.storage.storesWithDueMarks(ctx.now()), [STORE]);
});
