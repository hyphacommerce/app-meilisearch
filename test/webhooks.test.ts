import assert from "node:assert/strict";
import { test } from "node:test";

import { signRequest } from "@hypha/app";

import { type EventEnvelope, marksFor } from "../src/core/events.ts";
import { webhooks } from "../src/core/webhooks.ts";
import { id } from "./fixtures.ts";
import { SECRET, STORE, harness, install } from "./harness.ts";

const SUBJECT_PREFIX: Record<string, string> = {
  product: "prod",
  catalog: "cat",
  price_list: "pl",
  inventory_item: "inv",
  channel: "chan",
  category: "pcat",
  market: "mkt",
  location: "loc",
};

function envelope(type: string, data: Record<string, unknown>): EventEnvelope {
  const kind = type.split(".")[0] ?? "";
  const prefix = SUBJECT_PREFIX[kind];
  return {
    id: "evt_1",
    type,
    version: 1,
    // Prefixed for every kind with an ID type; `search_settings` keeps the nil UUID.
    subject: {
      type: kind,
      id: prefix ? id(prefix, 1) : "00000000-0000-0000-0000-000000000000",
      version: null,
    },
    actor: { type: "user", id: "user_1" },
    occurred_at: "2026-10-19T12:00:00Z",
    data,
  };
}

async function delivery(
  body: unknown,
  {
    secret = SECRET,
    deliveryId = "dlv_1",
    timestamp = 0,
    store = STORE,
  }: { secret?: string; deliveryId?: string; timestamp?: number; store?: string | null } = {},
) {
  const raw = JSON.stringify(body);
  const signature = await signRequest(secret, raw, timestamp ? { timestamp } : {});
  return new Request("http://app.test/hypha/webhooks", {
    method: "POST",
    headers: {
      "hypha-signature": signature,
      "hypha-delivery-id": deliveryId,
      ...(store === null ? {} : { "hypha-store": store }),
    },
    body: raw,
  });
}

async function setup() {
  const h = await harness();
  await install(h.ctx);
  const marked: number[] = [];
  const handle = webhooks(h.ctx, { onMarked: (_store, n) => marked.push(n) });
  return { ...h, handle, marked };
}

const P = id("prod", 1);
const V = id("var", 1);
const CAT = id("cat", 1);
const PL = id("pl", 1);
const PCAT = id("pcat", 1);
const CHAN = id("chan", 1);

test("events mark what they change, as Hypha's SearchIndexer does", () => {
  assert.deepEqual(marksFor(envelope("product.updated", { product: P, fields: ["title"] })), [
    { target: `product:${P}`, priority: 4 },
  ]);
  assert.deepEqual(
    marksFor(envelope("catalog.products_added", { catalog: CAT, products: [P] })).map(
      (m) => m.target,
    ),
    [`catalog:${CAT}`, `product:${P}`],
  );
  assert.deepEqual(
    marksFor(envelope("price_list.prices_set", { price_list: PL, variants: [V] })).map(
      (m) => m.target,
    ),
    [`price_list:${PL}`, `variant:${V}`],
  );
  assert.deepEqual(
    marksFor(envelope("inventory_item.changed", { inventory_item: id("inv", 1), variant: V })).map(
      (m) => m.target,
    ),
    [`variant:${V}`],
  );
  assert.deepEqual(
    marksFor(envelope("channel.products_unpublished", { channel: CHAN, products: [P] })).map(
      (m) => m.target,
    ),
    [`product:${P}`],
  );
  const market = id("mkt", 1);
  assert.deepEqual(marksFor(envelope("market.changed", { market, fields: ["name"] })), []);
  assert.deepEqual(marksFor(envelope("market.changed", { market, fields: ["currency"] })), [
    { target: "all", priority: 0 },
  ]);
  assert.deepEqual(
    marksFor(envelope("location.changed", { location: id("loc", 1), fields: ["markets"] })).length,
    1,
  );
  assert.deepEqual(marksFor(envelope("search_settings.changed", { fields: ["facets"] })), []);
  assert.deepEqual(
    marksFor(envelope("category.changed", { category: PCAT, created: false, fields: ["parent"] })),
    [{ target: `category:${PCAT}`, priority: 1 }],
  );
  assert.deepEqual(
    marksFor(envelope("category.products_added", { category: PCAT, products: [P] })).map(
      (m) => m.target,
    ),
    [`product:${P}`],
  );
  assert.deepEqual(marksFor(envelope("channel.changed", { channel: CHAN })), []);
  assert.throws(() => marksFor(envelope("product.created", {})), /`product`/);
});

test("IDs are prefixed: a bare UUID or another kind's ID is refused", () => {
  const bare = "0192a7c0-0000-7000-8000-000000000001";
  assert.throws(
    () => marksFor(envelope("category.changed", { category: bare, created: true })),
    /`category`/,
  );
  assert.throws(
    () => marksFor(envelope("channel.products_published", { channel: CHAN, products: [bare] })),
    /`products`/,
  );
  assert.throws(
    () => marksFor(envelope("category.changed", { category: CHAN, created: true })),
    /`category`/,
  );
  assert.throws(() => marksFor(envelope("product.updated", { product: "prod_" })), /`product`/);
});

test("a webhook signed with the named store's secret marks its work", async () => {
  const { ctx, handle, marked } = await setup();
  const response = await handle(
    await delivery(envelope("product.updated", { product: P, fields: ["title"] })),
  );
  assert.equal(response.status, 204);
  assert.equal(await ctx.storage.countMarks(STORE), 1);
  assert.deepEqual(marked, [1]);
});

test("a repeated delivery is acknowledged and ignored", async () => {
  const { ctx, handle, marked } = await setup();
  const body = envelope("product.updated", { product: P });
  assert.equal((await handle(await delivery(body))).status, 204);
  assert.equal((await handle(await delivery(body))).status, 204);
  const marks = await ctx.storage.lease(STORE, [0, 9], 10, ctx.now(), 1000);
  // Marked once: generation 1.
  assert.deepEqual(marks, [{ target: `product:${P}`, generation: 1, priority: 4 }]);
  assert.deepEqual(marked, [1]);
});

test("a wrong secret, a stale timestamp, an unknown or missing store is refused", async () => {
  const { ctx, handle } = await setup();
  const body = envelope("product.updated", { product: P });
  const status = async (request: Request) => (await handle(request)).status;
  assert.equal(await status(await delivery(body, { secret: "other" })), 401);
  const old = Math.floor(ctx.now() / 1000) - 3600;
  assert.equal(await status(await delivery(body, { timestamp: old })), 401);
  // The store picks the secret: no other installation's is tried.
  assert.equal(await status(await delivery(body, { store: id("store", 9) })), 401);
  assert.equal(await status(await delivery(body, { store: null })), 401);
  const unsigned = new Request("http://app.test/hypha/webhooks", {
    method: "POST",
    headers: { "hypha-store": STORE },
    body: "{}",
  });
  assert.equal(await status(unsigned), 401);
  assert.equal(await ctx.storage.countMarks(STORE), 0);
});

test("a body that isn't an envelope is a 400", async () => {
  const { handle } = await setup();
  const response = await handle(await delivery({ id: "evt_1", type: "product.updated" }));
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { code: string }).code, "invalid_request");
});

test("a payload that breaks its promise fails, and its retry is handled again", async () => {
  const { ctx, handle } = await setup();
  const bad = envelope("catalog.products_added", { catalog: CAT, products: P });
  const first = await handle(await delivery(bad));
  assert.equal(first.status, 500);
  assert.equal(((await first.json()) as { code: string }).code, "handler_failed");
  // Not recorded: a retry is handled again.
  assert.equal(await ctx.storage.hasDelivery(STORE, "dlv_1"), false);
  assert.equal((await handle(await delivery(bad))).status, 500);
});

test("app.uninstalled forgets the store", async () => {
  const { ctx, handle, marked } = await setup();
  const response = await handle(await delivery(envelope("app.uninstalled", {})));
  assert.equal(response.status, 204);
  assert.equal(await ctx.storage.getInstallation(STORE), undefined);
  assert.deepEqual(marked, []);
});
