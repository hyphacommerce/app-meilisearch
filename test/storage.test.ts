import assert from "node:assert/strict";
import { test } from "node:test";

import { Vault } from "../src/core/crypto.ts";
import { migrate } from "../src/core/sql.ts";
import { KEY, STORE, harness } from "./harness.ts";

test("migrations apply once", async () => {
  const { db } = await harness();
  assert.deepEqual(await migrate(db), []);
});

test("marking a marked target coalesces into a new generation", async () => {
  const { ctx } = await harness();
  const s = ctx.storage;
  await s.mark(STORE, [{ target: "product:1", priority: 4 }], 1);
  await s.mark(STORE, [{ target: "product:1", priority: 4 }], 2);
  assert.equal(await s.countMarks(STORE), 1);
  const [mark] = await s.lease(STORE, [4, 4], 10, 10, 1000);
  assert.deepEqual(mark, { target: "product:1", generation: 2, priority: 4 });
  // Leased: not due again until the lease runs out.
  assert.deepEqual(await s.lease(STORE, [4, 4], 10, 20, 1000), []);
  assert.deepEqual(await s.storesWithDueMarks(20), []);
  assert.equal((await s.lease(STORE, [4, 4], 10, 1011, 1000)).length, 1);
});

test("finishing keeps a mark marked again meanwhile, and frees it", async () => {
  const { ctx } = await harness();
  const s = ctx.storage;
  await s.mark(STORE, [{ target: "product:1", priority: 4 }], 1);
  const [mark] = await s.lease(STORE, [0, 9], 10, 10, 1000);
  assert.ok(mark);
  await s.mark(STORE, [{ target: "product:1", priority: 4 }], 11);
  await s.finish(STORE, mark);
  const [again] = await s.lease(STORE, [0, 9], 10, 12, 1000);
  assert.equal(again?.generation, 2);
  await s.finish(STORE, again ?? mark);
  assert.equal(await s.countMarks(STORE), 0);
});

test("leases go most urgent first, within the asked priorities", async () => {
  const { ctx } = await harness();
  const s = ctx.storage;
  await s.mark(
    STORE,
    [
      { target: "product:1", priority: 4 },
      { target: "all", priority: 0 },
      { target: "variant:1", priority: 1 },
    ],
    1,
  );
  assert.deepEqual(
    (await s.lease(STORE, [0, 1], 10, 5, 100)).map((m) => m.target),
    ["all", "variant:1"],
  );
});

test("caches replace whole and answer by product and variant", async () => {
  const { ctx } = await harness();
  const s = ctx.storage;
  await s.replaceCatalogProducts(STORE, "cat_1", ["p1", "p2"]);
  await s.replaceCatalogProducts(STORE, "cat_1", ["p2"]);
  assert.deepEqual(await s.catalogsWith(STORE, "p1"), []);
  assert.deepEqual(await s.catalogsWith(STORE, "p2"), ["cat_1"]);
  await s.replaceFixedPrices(STORE, "pl_1", [{ variant: "v1", amount: 5, currency: "GBP" }]);
  assert.deepEqual(await s.fixedPrices(STORE, "pl_1", ["v1", "v2"]), [
    { variant: "v1", amount: 5, currency: "GBP" },
  ]);
  await s.setVariants(STORE, "p1", ["v1", "v2"]);
  assert.deepEqual(await s.productsOfVariants(STORE, ["v2", "v9"]), ["p1"]);
});

test("one refresh lock at a time", async () => {
  const { ctx } = await harness();
  const { install } = await import("./harness.ts");
  await install(ctx);
  assert.equal(await ctx.storage.tryLockRefresh(STORE, 100, 200), true);
  assert.equal(await ctx.storage.tryLockRefresh(STORE, 150, 250), false);
  assert.equal(await ctx.storage.tryLockRefresh(STORE, 201, 300), true);
});

test("sealed values open only with their key and context", async () => {
  const vault = new Vault(KEY);
  const sealed = await vault.seal("secret", "store_1:meili_key");
  assert.equal(await vault.open(sealed, "store_1:meili_key"), "secret");
  await assert.rejects(vault.open(sealed, "store_2:meili_key"));
  await assert.rejects(new Vault("11".repeat(32)).open(sealed, "store_1:meili_key"));
  assert.throws(() => new Vault("short"), /64 hex/);
});
