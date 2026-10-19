import assert from "node:assert/strict";
import { test } from "node:test";

import type { MeiliClient, MeiliSearchQuery, MeiliSearchResult } from "../src/core/meili.ts";
import {
  type SearchRequest,
  answer,
  distinctFor,
  facetAttribute,
  filterFor,
  planSearch,
  search,
  sortFor,
} from "../src/core/query.ts";

const COLOR = "opt.636f6c6f72";
const request = (over: Partial<SearchRequest> = {}): SearchRequest => ({
  query: "",
  market: "mkt_00000000000000000000000000000001",
  currency: "EUR",
  sort: "relevance",
  group: "listing",
  offset: 0,
  limit: 24,
  ...over,
});

test("facet keys map to their attributes", () => {
  assert.equal(facetAttribute("vendor"), "vendor");
  assert.equal(facetAttribute("product_type"), "product_type");
  assert.equal(facetAttribute("tag"), "tags");
  assert.equal(facetAttribute("option.color"), COLOR);
  assert.equal(facetAttribute("option.Color"), COLOR);
  assert.equal(facetAttribute("option."), undefined);
  assert.equal(facetAttribute("price"), undefined);
});

test("groups collapse on their key; variants don't", () => {
  assert.equal(distinctFor("listing"), "listing");
  assert.equal(distinctFor("product"), "product");
  assert.equal(distinctFor("variant"), undefined);
});

test("sorts end in Hypha's tie-breaks", () => {
  const tail = ["created_at:desc", "product:desc", "listing:asc", "position:asc"];
  assert.deepEqual(sortFor(request({ sort: "newest" })), tail);
  assert.deepEqual(sortFor(request({ sort: "relevance", query: "shirt" })), tail);
  assert.deepEqual(sortFor(request({ sort: "price_asc" })), ["price:asc", ...tail]);
  assert.deepEqual(sortFor(request({ sort: "price_desc" })), ["price:desc", ...tail]);
  assert.deepEqual(sortFor(request({ sort: "title" })), ["title_sort:asc", ...tail]);
  // Within a product, ties go by position.
  assert.deepEqual(sortFor(request({ sort: "price_asc", group: "product" })), [
    "price:asc",
    "created_at:desc",
    "product:desc",
    "position:asc",
  ]);
});

test("filters: values OR, facets AND, plus channel, category, availability and price", () => {
  assert.deepEqual(
    filterFor(
      request({
        channel: "chan_1",
        category: "pcat_1",
        available: true,
        price: { min: 1000, max: 5000 },
        filters: [
          { facet: "option.color", values: ["Red", 'Bl"ue'] },
          { facet: "vendor", values: ["Loom"] },
        ],
      }),
    ),
    [
      'channels = "chan_1"',
      'categories = "pcat_1"',
      "available = true",
      "price >= 1000",
      "price <= 5000",
      `"${COLOR}" IN ["Red", "Bl\\"ue"]`,
      '"vendor" IN ["Loom"]',
    ],
  );
  assert.deepEqual(filterFor(request({ available: false, price: { min: null } })), [
    "available = false",
  ]);
});

test("a filter without values or on an unknown facet matches nothing", () => {
  assert.equal(filterFor(request({ filters: [{ facet: "vendor", values: [] }] })), undefined);
  assert.equal(filterFor(request({ filters: [{ facet: "colour", values: ["x"] }] })), undefined);
  // ... unless it's the facet being left out.
  assert.deepEqual(
    filterFor(request({ filters: [{ facet: "vendor", values: [] }] }), "vendor"),
    [],
  );
});

test("the plan pages hits by offset and counts with page mode", () => {
  const plan = planSearch("idx", request({ query: " shirt ", offset: 48, limit: 24 }));
  assert.deepEqual(plan.hits, {
    indexUid: "idx",
    q: "shirt",
    filter: [],
    distinct: "listing",
    sort: ["created_at:desc", "product:desc", "listing:asc", "position:asc"],
    offset: 48,
    limit: 24,
    attributesToRetrieve: ["product", "variant"],
  });
  assert.deepEqual(plan.count, {
    indexUid: "idx",
    q: "shirt",
    filter: [],
    distinct: "listing",
    page: 1,
    hitsPerPage: 0,
  });
});

test("facets: product-level ones are counted with the groups, options exactly, filtered ones on their own", () => {
  const plan = planSearch(
    "idx",
    request({
      facets: ["vendor", "option.color", "tag", "option.size", "nope"],
      filters: [{ facet: "tag", values: ["Summer"] }],
    }),
  );
  assert.deepEqual(plan.count.facets, ["vendor"]);
  const [vendor, color, tag, size, nope] = plan.facets;
  assert.deepEqual(vendor, { facet: "vendor", kind: "count", attribute: "vendor" });
  assert.equal(color?.kind, "own");
  if (color?.kind === "own") {
    assert.equal(color.exact, true);
    // Exact counting reads documents' values: no distinct.
    assert.equal(color.query.distinct, undefined);
    assert.deepEqual(color.query.filter, ['"tags" IN ["Summer"]']);
  }
  assert.equal(tag?.kind, "own");
  if (tag?.kind === "own") {
    assert.equal(tag.exact, false);
    assert.equal(tag.query.distinct, "listing");
    // Its own filter is left out (disjunctive facets).
    assert.deepEqual(tag.query.filter, []);
  }
  assert.equal(size?.kind, "own");
  assert.deepEqual(nope, { facet: "nope", kind: "none" });
});

test("with one hit per variant, every facet counts with the hits", () => {
  const plan = planSearch("idx", request({ group: "variant", facets: ["option.color", "vendor"] }));
  assert.deepEqual(plan.count.facets, [COLOR, "vendor"]);
  assert.equal(plan.count.distinct, undefined);
});

test("the answer keeps at most `limit` hits and only the asked facets, in order", () => {
  const req = request({ limit: 1, facets: ["vendor", "nope"] });
  const plan = planSearch("idx", req);
  const response = answer(
    plan,
    req,
    {
      hits: {
        indexUid: "idx",
        hits: [
          { product: "prod_1", variant: "var_1" },
          { product: "prod_2", variant: "var_2" },
        ],
      },
      count: {
        indexUid: "idx",
        hits: [],
        totalHits: 2,
        facetDistribution: { vendor: { Loom: 1, Kiln: 1, Acme: 3 }, tags: { x: 1 } },
      },
      own: new Map(),
    },
    new Map(),
  );
  assert.deepEqual(response, {
    hits: [{ product: "prod_1", variant: "var_1" }],
    total: 2,
    facets: [
      {
        facet: "vendor",
        values: [
          { value: "Acme", count: 3 },
          { value: "Kiln", count: 1 },
          { value: "Loom", count: 1 },
        ],
      },
      { facet: "nope", values: [] },
    ],
  });
});

/** A Meilisearch that answers each query with `respond`, recording them. */
function fakeMeili(respond: (query: MeiliSearchQuery) => MeiliSearchResult) {
  const calls: MeiliSearchQuery[][] = [];
  const meili = {
    multiSearch: async (queries: MeiliSearchQuery[]) => {
      calls.push(queries);
      return queries.map(respond);
    },
  } as unknown as MeiliClient;
  return { meili, calls };
}

test("option facets count groups: one query per value seen on more than one document", async () => {
  const { meili, calls } = fakeMeili((query) => {
    const filter = query.filter ?? [];
    if (query.facets?.includes(COLOR))
      return { indexUid: "idx", hits: [], facetDistribution: { [COLOR]: { Red: 3, Blue: 1 } } };
    if (filter.some((f) => f.endsWith('= "Red"')))
      return { indexUid: "idx", hits: [], totalHits: 2 };
    return { indexUid: "idx", hits: [{ product: "prod_1", variant: "var_1" }], totalHits: 2 };
  });
  const response = await search(meili, "idx", request({ facets: ["option.color"] }));
  assert.equal(calls.length, 2);
  // Only Red needed counting; it ran with the group's distinct.
  assert.equal(calls[1]?.length, 1);
  assert.equal(calls[1]?.[0]?.distinct, "listing");
  assert.deepEqual(response.facets, [
    {
      facet: "option.color",
      values: [
        { value: "Red", count: 2 },
        { value: "Blue", count: 1 },
      ],
    },
  ]);
  assert.equal(response.total, 2);
});

test("a filter that matches nothing answers no hits without asking for them", async () => {
  const { meili, calls } = fakeMeili(() => ({ indexUid: "idx", hits: [] }));
  const response = await search(
    meili,
    "idx",
    request({ filters: [{ facet: "vendor", values: [] }], facets: [] }),
  );
  assert.deepEqual(response, { hits: [], total: 0, facets: [] });
  assert.equal(calls.length, 0);
});
