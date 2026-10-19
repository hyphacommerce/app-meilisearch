import assert from "node:assert/strict";
import { test } from "node:test";

import { signRequest } from "@hypha/app";

import { type EventEnvelope, marksFor } from "../src/core/events.ts";
import { handleWebhook } from "../src/core/webhooks.ts";
import { SECRET, STORE, harness, install } from "./harness.ts";

function envelope(type: string, data: Record<string, unknown>): EventEnvelope {
  return {
    id: "evt_1",
    type,
    version: 1,
    subject: { type: type.split(".")[0] ?? "", id: "x" },
    occurred_at: "2026-10-19T12:00:00Z",
    data,
  };
}

async function delivery(body: unknown, { secret = SECRET, id = "dlv_1", timestamp = 0 } = {}) {
  const raw = JSON.stringify(body);
  const signature = await signRequest(secret, raw, timestamp ? { timestamp } : {});
  return new Request("http://app.test/hypha/webhooks", {
    method: "POST",
    headers: { "hypha-signature": signature, "hypha-delivery-id": id },
    body: raw,
  });
}

test("events mark what they change, as Hypha's SearchIndexer does", () => {
  const p = "prod_1";
  assert.deepEqual(marksFor(envelope("product.updated", { product: p, fields: ["title"] })), [
    { target: "product:prod_1", priority: 4 },
  ]);
  assert.deepEqual(
    marksFor(envelope("catalog.products_added", { catalog: "cat_1", products: [p] })).map(
      (m) => m.target,
    ),
    ["catalog:cat_1", "product:prod_1"],
  );
  assert.deepEqual(
    marksFor(envelope("price_list.prices_set", { price_list: "pl_1", variants: ["var_1"] })).map(
      (m) => m.target,
    ),
    ["price_list:pl_1", "variant:var_1"],
  );
  assert.deepEqual(
    marksFor(envelope("inventory_item.changed", { inventory_item: "inv_1", variant: "var_1" })).map(
      (m) => m.target,
    ),
    ["variant:var_1"],
  );
  assert.deepEqual(
    marksFor(envelope("channel.products_unpublished", { channel: "c", products: [p] })).map(
      (m) => m.target,
    ),
    ["product:prod_1"],
  );
  assert.deepEqual(marksFor(envelope("market.changed", { market: "m", fields: ["name"] })), []);
  assert.deepEqual(marksFor(envelope("market.changed", { market: "m", fields: ["currency"] })), [
    { target: "all", priority: 0 },
  ]);
  assert.deepEqual(
    marksFor(envelope("location.changed", { location: "l", fields: ["markets"] })).length,
    1,
  );
  assert.deepEqual(marksFor(envelope("search_settings.changed", { fields: ["facets"] })), []);
  assert.deepEqual(
    marksFor(
      envelope("category.changed", { category: "pcat_1", created: false, fields: ["parent"] }),
    ),
    [{ target: "category:pcat_1", priority: 1 }],
  );
  assert.deepEqual(marksFor(envelope("channel.changed", { channel: "c" })), []);
  assert.throws(() => marksFor(envelope("product.created", {})), /`product`/);
});

test("a webhook signed with the installation's secret marks its work", async () => {
  const { ctx } = await harness();
  await install(ctx);
  const outcome = await handleWebhook(
    ctx,
    await delivery(envelope("product.updated", { product: "prod_1", fields: ["title"] })),
  );
  assert.deepEqual(outcome, { status: 200, code: "accepted", store: STORE, marks: 1 });
  assert.equal(await ctx.storage.countMarks(STORE), 1);
});

test("a repeated delivery is acknowledged and ignored", async () => {
  const { ctx } = await harness();
  await install(ctx);
  const body = envelope("product.updated", { product: "prod_1" });
  await handleWebhook(ctx, await delivery(body));
  const again = await handleWebhook(ctx, await delivery(body));
  assert.equal(again.code, "duplicate");
  const marks = await ctx.storage.lease(STORE, [0, 9], 10, ctx.now(), 1000);
  // Marked once: generation 1.
  assert.deepEqual(marks, [{ target: "product:prod_1", generation: 1, priority: 4 }]);
});

test("a wrong secret or a stale timestamp is refused", async () => {
  const { ctx } = await harness();
  await install(ctx);
  const body = envelope("product.updated", { product: "prod_1" });
  assert.equal((await handleWebhook(ctx, await delivery(body, { secret: "other" }))).status, 401);
  const old = Math.floor(ctx.now() / 1000) - 3600;
  assert.equal((await handleWebhook(ctx, await delivery(body, { timestamp: old }))).status, 401);
  const unsigned = new Request("http://app.test/hypha/webhooks", { method: "POST", body: "{}" });
  assert.equal((await handleWebhook(ctx, unsigned)).status, 401);
});

test("a payload that breaks its promise is refused and can be retried", async () => {
  const { ctx } = await harness();
  await install(ctx);
  const bad = envelope("catalog.products_added", { catalog: "cat_1", products: "prod_1" });
  const first = await handleWebhook(ctx, await delivery(bad));
  assert.equal(first.status, 400);
  // Not recorded: a retry is handled again.
  assert.equal((await handleWebhook(ctx, await delivery(bad))).status, 400);
});

test("app.uninstalled forgets the store", async () => {
  const { ctx } = await harness();
  await install(ctx);
  const outcome = await handleWebhook(ctx, await delivery(envelope("app.uninstalled", {})));
  assert.equal(outcome.code, "uninstalled");
  assert.equal(await ctx.storage.getInstallation(STORE), undefined);
});
