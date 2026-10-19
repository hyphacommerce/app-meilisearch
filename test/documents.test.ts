import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CategoryTree,
  type MarketContext,
  adjust,
  buildDocuments,
  descriptionText,
  expandCategories,
  isAvailable,
  listingKey,
  optionAttribute,
  resolvePrice,
} from "../src/core/documents.ts";
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

const eu: MarketContext = { id: MARKET_EU, currency: "EUR", catalog: CATALOG_EU, priceList: null };
const uk: MarketContext = {
  id: MARKET_UK,
  currency: "GBP",
  catalog: CATALOG_UK,
  priceList: { id: LIST_UK, currency: "GBP", adjustmentBps: -1000 },
};
const noFixed = new Map();

test("adjust rounds half away from zero, like Money::adjust", () => {
  assert.equal(adjust(1000, -1000), 900);
  assert.equal(adjust(1005, -1000), 905); // 904.5
  assert.equal(adjust(1006, -1000), 905); // 905.4
  assert.equal(adjust(-1005, -1000), -905);
  assert.equal(adjust(Number.MAX_SAFE_INTEGER, 1), undefined);
});

test("a product outside the market's catalog has no price", () => {
  const base = { amount: 1000, currency: "EUR" };
  assert.equal(resolvePrice(eu, { inCatalog: false, fixed: noFixed }, "v", base), undefined);
  assert.equal(
    resolvePrice({ ...eu, catalog: null }, { inCatalog: true, fixed: noFixed }, "v", base),
    undefined,
  );
});

test("without a price list the base price counts only in the market's currency", () => {
  const pricing = { inCatalog: true, fixed: noFixed };
  assert.equal(resolvePrice(eu, pricing, "v", { amount: 1000, currency: "EUR" }), 1000);
  assert.equal(resolvePrice(eu, pricing, "v", { amount: 1000, currency: "GBP" }), undefined);
});

test("a fixed price wins over the list's adjustment", () => {
  const fixed = new Map([["v", { amount: 777, currency: "GBP" }]]);
  assert.equal(
    resolvePrice(uk, { inCatalog: true, fixed }, "v", { amount: 1000, currency: "EUR" }),
    777,
  );
});

test("a list adjusts base prices in its currency and refuses others", () => {
  const pricing = { inCatalog: true, fixed: noFixed };
  assert.equal(resolvePrice(uk, pricing, "v", { amount: 1005, currency: "GBP" }), 905);
  assert.equal(resolvePrice(uk, pricing, "v", { amount: 1005, currency: "EUR" }), undefined);
  assert.equal(
    resolvePrice(
      { ...uk, priceList: { id: LIST_UK, currency: "EUR", adjustmentBps: 0 } },
      pricing,
      "v",
      {
        amount: 1005,
        currency: "GBP",
      },
    ),
    undefined,
  );
  assert.equal(
    resolvePrice({ ...uk, priceList: "missing" }, pricing, "v", { amount: 1005, currency: "GBP" }),
    undefined,
  );
});

test("availability follows the serving locations, as carts decide", () => {
  const serving = [stockLocation(LOCATION_EU, [MARKET_EU])];
  const stock = (i: ReturnType<typeof item>) => ({
    items: new Map([[i.variant, i]]),
    locations: serving,
  });
  assert.equal(isAvailable(id("var", 1), { items: new Map(), locations: serving }), true);
  assert.equal(isAvailable(id("var", 1), stock(item(1, [[LOCATION_EU, 1]]))), true);
  assert.equal(isAvailable(id("var", 1), stock(item(1, [[LOCATION_EU, 0]]))), false);
  // Stock elsewhere doesn't count.
  assert.equal(isAvailable(id("var", 1), stock(item(1, [[LOCATION_UK, 5]]))), false);
  assert.equal(
    isAvailable(id("var", 1), stock(item(1, [[LOCATION_EU, 0]], { continueSelling: true }))),
    true,
  );
  assert.equal(
    isAvailable(id("var", 1), stock(item(1, [[LOCATION_EU, 0]], { tracked: false }))),
    true,
  );
  // Tracked with no serving location at all: out, even selling past zero.
  assert.equal(
    isAvailable(id("var", 1), {
      items: new Map([[id("var", 1), item(1, [], { continueSelling: true })]]),
      locations: [],
    }),
    false,
  );
});

test("description text drops tags and decodes Hypha's entities", () => {
  assert.equal(descriptionText('<p>a</p><p title="x>y">b &amp; c</p>'), "a b & c");
  assert.equal(descriptionText(null), "");
});

test("listing keys follow split options in the settings' order", () => {
  const options: [string, string][] = [
    ["Size", "M"],
    ["Color", "Red"],
  ];
  assert.equal(listingKey("prod_1", options, []), "prod_1");
  assert.equal(listingKey("prod_1", options, ["COLOR", "Material"]), "prod_1|color=Red");
});

test("categories are the shown ones and their ancestors", () => {
  const tree = new CategoryTree([
    {
      id: "c1",
      handle: "c1",
      name: "Clothing",
      position: 0,
      visible: true,
      children: [
        { id: "c2", handle: "c2", name: "Shirts", position: 0, visible: true, children: [] },
        {
          id: "c3",
          handle: "c3",
          name: "Hidden",
          position: 1,
          visible: false,
          children: [
            { id: "c4", handle: "c4", name: "Below", position: 0, visible: true, children: [] },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(expandCategories(["c2"], tree), ["c1", "c2"]);
  assert.deepEqual(expandCategories(["c4"], tree), []);
  assert.deepEqual(tree.subtree("c1").toSorted(), ["c1", "c2", "c3", "c4"]);
});

test("documents: one per priced variant, with product fields and option facets", () => {
  const [shirt] = catalogue();
  assert.ok(shirt);
  const documents = buildDocuments({
    product: shirt,
    market: eu,
    pricing: { inCatalog: true, fixed: noFixed },
    stock: {
      items: new Map([[id("var", 12), item(12, [[LOCATION_EU, 0]])]]),
      locations: [stockLocation(LOCATION_EU, [MARKET_EU])],
    },
    splitBy: ["color"],
    categories: ["c1", "c2"],
  });
  assert.equal(documents.length, 3);
  const [first, second] = documents;
  assert.deepEqual(first, {
    id: id("var", 11),
    product: id("prod", 1),
    variant: id("var", 11),
    listing: `${id("prod", 1)}|color=Red`,
    channels: [id("chan", 1)],
    categories: ["c1", "c2"],
    handle: "linen-shirt",
    title: "Linen Shirt",
    title_sort: "linen shirt",
    variant_title: "Red / S",
    description: "Light linen & airy",
    vendor: "Loom",
    product_type: "Shirts",
    tags: ["Summer", "Linen"],
    sku: "LS-RED-S",
    option_values: ["Red", "S"],
    opt: { "636f6c6f72": "Red", "73697a65": "S" },
    price: 4000,
    currency: "EUR",
    available: true,
    created_at: Date.parse("2026-01-02T00:00:00Z"),
    position: 0,
  });
  assert.equal(second?.available, false);
  assert.equal(optionAttribute("Color"), "opt.636f6c6f72");
});

test("inactive products and unpriced variants have no documents", () => {
  const [, mug, draft] = catalogue();
  assert.ok(mug && draft);
  const input = {
    pricing: { inCatalog: true, fixed: noFixed },
    stock: { items: new Map(), locations: [] },
    splitBy: [],
    categories: [],
  };
  assert.deepEqual(buildDocuments({ ...input, product: draft, market: eu }), []);
  // The mug's base price is in EUR: none in the GBP market without a fixed price.
  assert.deepEqual(buildDocuments({ ...input, product: mug, market: uk }), []);
  const fixed = new Map([[id("var", 21), { amount: 1300, currency: "GBP" }]]);
  const priced = buildDocuments({
    ...input,
    product: mug,
    market: uk,
    pricing: { inCatalog: true, fixed },
  });
  assert.equal(priced[0]?.price, 1300);
  assert.equal(priced[0]?.currency, "GBP");
});
