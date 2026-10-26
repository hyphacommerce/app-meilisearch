// The query mapping against a real Meilisearch, held to Hypha's reference search
// (`reference.ts`) over a battery of queries: every group, every sort but relevance,
// filters, price, availability, channel, category, pages and facets.
//
//   MEILI_URL=http://127.0.0.1:7700 MEILI_KEY=<master key> pnpm test:integration

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  type MarketContext,
  type SearchDocument,
  buildDocuments,
} from "../../src/core/documents.ts";
import { INDEX_SETTINGS } from "../../src/core/index-settings.ts";
import { MeiliClient } from "../../src/core/meili.ts";
import { type SearchRequest, search } from "../../src/core/query.ts";
import {
  CATALOG_EU,
  LOCATION_EU,
  MARKET_EU,
  id,
  item,
  stockLocation,
  product,
} from "../fixtures.ts";
import { referenceSearch } from "./reference.ts";

const url = process.env.MEILI_URL;
const key = process.env.MEILI_KEY ?? "";
const skip = url ? false : "MEILI_URL isn't set";
const INDEX = `test_${Date.now()}`;
const meili = new MeiliClient({ url: url ?? "http://127.0.0.1:1", apiKey: key });

const COLORS = ["Red", "Blue", "Green", "Black"];
const SIZES = ["S", "M", "L"];
const VENDORS = ["Loom", "Kiln", "Acme"];
const TAGS = ["Summer", "Linen", "Sale", "Kitchen"];
const CATEGORY = id("pcat", 1);
const OTHER_CHANNEL = id("chan", 2);

let state = 7;
const random = () => {
  state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
  return state / 4_294_967_296;
};
const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;

function fixture(): SearchDocument[] {
  const market: MarketContext = {
    id: MARKET_EU,
    currency: "EUR",
    catalog: CATALOG_EU,
    priceLists: [],
  };
  const documents: SearchDocument[] = [];
  for (let n = 1; n <= 24; n++) {
    const colors = COLORS.filter(() => random() < 0.6);
    if (colors.length === 0) colors.push(pick(COLORS));
    const sizes = n % 4 === 0 ? [] : SIZES.filter(() => random() < 0.7);
    const options = [
      { name: "Color", values: colors },
      ...(sizes.length > 0 ? [{ name: "Size", values: sizes }] : []),
    ];
    const variants = [];
    let v = 0;
    for (const color of colors)
      for (const size of sizes.length > 0 ? sizes : [undefined]) {
        // Sparse: not every combination.
        if (v > 0 && random() < 0.25) continue;
        v++;
        variants.push({
          n: n * 100 + v,
          // Some equal prices, to test ties.
          price: 1000 + Math.floor(random() * 8) * 500,
          values: size ? [color, size] : [color],
        });
      }
    const p = product({
      n,
      title: `${pick(["Linen", "Wool", "Cotton", "Stone"])} ${pick(["Shirt", "Mug", "Scarf", "Bowl"])} ${n}`,
      // Pairs of products created at the same instant: ties go by product ID.
      created: new Date(Date.UTC(2026, 0, 1 + Math.floor(n / 2))).toISOString(),
      vendor: pick(VENDORS),
      product_type: pick(["Shirts", "Mugs"]),
      tags: TAGS.filter(() => random() < 0.4),
      channels: n % 5 === 0 ? [OTHER_CHANNEL] : [id("chan", 1)],
      options,
      variants,
    });
    const stock = new Map(
      p.variants.map((variant, i) => [
        variant.id,
        { ...item(0, [[LOCATION_EU, (n + i) % 3 === 0 ? 0 : 5]]), variant: variant.id },
      ]),
    );
    documents.push(
      ...buildDocuments({
        product: p,
        market,
        pricing: { inCatalog: true, product: p.id, categories: new Set(), fixed: new Map() },
        stock: { items: stock, locations: [stockLocation(LOCATION_EU, [MARKET_EU])] },
        splitBy: ["color"],
        categories: n % 2 === 0 ? [CATEGORY] : [],
      }),
    );
  }
  return documents;
}

const documents = fixture();

before(async () => {
  if (skip) return;
  await meili.updateSettings(INDEX, INDEX_SETTINGS);
  await meili.addDocuments(INDEX, documents);
  await meili.waitForIdle(60_000);
});

after(async () => {
  if (skip) return;
  await meili.deleteIndex(INDEX).catch(() => {});
});

const base: SearchRequest = {
  query: "",
  market: MARKET_EU,
  currency: "EUR",
  sort: "newest",
  group: "listing",
  offset: 0,
  limit: 100,
};

const FACETS = ["option.color", "option.size", "vendor", "tag", "product_type"];

function battery(): [string, SearchRequest][] {
  const out: [string, SearchRequest][] = [];
  const variations: [string, Partial<SearchRequest>][] = [
    ["everything", {}],
    ["red", { filters: [{ facet: "option.color", values: ["Red"] }] }],
    [
      "red or blue, M",
      {
        filters: [
          { facet: "option.color", values: ["Red", "Blue"] },
          { facet: "option.size", values: ["M"] },
        ],
      },
    ],
    [
      "vendor and tag",
      {
        filters: [
          { facet: "vendor", values: ["Loom", "Acme"] },
          { facet: "tag", values: ["Sale"] },
        ],
      },
    ],
    ["price range", { price: { min: 2000, max: 3500 } }],
    ["available", { available: true }],
    ["sold out", { available: false }],
    ["channel", { channel: id("chan", 1) }],
    ["category", { category: CATEGORY }],
    [
      "everything at once",
      {
        channel: id("chan", 1),
        available: true,
        price: { min: 1500, max: null },
        filters: [{ facet: "option.color", values: ["Green", "Black", "Red"] }],
      },
    ],
    ["no values", { filters: [{ facet: "vendor", values: [] }] }],
  ];
  for (const group of ["listing", "product", "variant"] as const)
    for (const sort of ["newest", "price_asc", "price_desc", "title"] as const)
      for (const [name, over] of variations)
        out.push([`${group} ${sort} ${name}`, { ...base, group, sort, facets: FACETS, ...over }]);
  // Pages, including one not aligned to the limit.
  for (const offset of [0, 7, 10, 30])
    out.push([
      `page from ${offset}`,
      { ...base, sort: "price_asc", offset, limit: 10, facets: [] },
    ]);
  return out;
}

test(
  "Meilisearch answers every query of the battery as Hypha's reference does",
  { skip },
  async () => {
    const failures: string[] = [];
    for (const [name, request] of battery()) {
      const actual = await search(meili, INDEX, request);
      const expected = referenceSearch(documents, request);
      try {
        assert.deepEqual(actual, expected);
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message.slice(0, 2000)}`);
      }
    }
    assert.deepEqual(failures, []);
  },
);

test("relevance finds the words in titles, tags and SKUs", { skip }, async () => {
  const found = await search(meili, INDEX, {
    ...base,
    sort: "relevance",
    query: "wool",
    group: "product",
  });
  const expected = new Set(documents.filter((d) => /wool/i.test(d.title)).map((d) => d.product));
  assert.deepEqual(new Set(found.hits.map((h) => h.product)), expected);
  assert.equal(found.total, expected.size);
  // A typo still finds them (Meilisearch's typo tolerance).
  const typo = await search(meili, INDEX, {
    ...base,
    sort: "relevance",
    query: "linnen",
    group: "product",
  });
  assert.ok(typo.total > 0);
});
