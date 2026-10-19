// `search.query` v1 (design note 0029, §3.1) on Meilisearch, meaning what Hypha's own
// search means (design note 0019, §4, `reference::search`) as closely as Meilisearch
// allows:
//
// - **Filters:** values of one facet OR, facets AND; channel, category, availability and
//   price bounds apply to each variant's document, so "Red" and "XL" match only a variant
//   that is both.
// - **Groups:** `listing` and `product` collapse with `distinct`; the representative is
//   the group's best document by the sort (the cheapest for `price_asc`), then position.
// - **Order:** the sort's key, then newest product, product ID, listing key, position.
//   `relevance` is Meilisearch's ranking (words, typos, proximity, attribute order),
//   with the same tie-breaks; without words it's `newest`.
// - **Facets** count groups, each ignoring its own filter (disjunctive). Meilisearch's
//   facet distribution under `distinct` counts only each group's representative, which
//   is right for product-level facets (vendor, type, tags: the same on every variant)
//   but not for options, so an option facet's groups are counted exactly, one query per
//   value (design note 0019, Q3).
// - **Total** is Meilisearch's exhaustive `totalHits` (capped at `MAX_TOTAL_HITS`).
//
// Where Meilisearch differs on purpose: typo tolerance and prefix matching on the last
// word only (Hypha's reference matches every word as a prefix), its own ranking, and
// filters that compare strings ignoring case.

import type { SearchQueryRequest, SearchQueryResponse } from "@hypha/app";

import { optionAttribute } from "./documents.ts";
import { MAX_FACET_VALUES } from "./index-settings.ts";
import { type MeiliClient, type MeiliSearchQuery, type MeiliSearchResult, quote } from "./meili.ts";

export type SearchRequest = SearchQueryRequest;
export type SearchResponse = SearchQueryResponse;
type FacetCounts = NonNullable<SearchResponse["facets"]>[number];

/** The attribute a facet key (`vendor`, `option.color`, …) lives in; unknown keys have none. */
export function facetAttribute(facet: string): string | undefined {
  if (facet === "vendor") return "vendor";
  if (facet === "product_type") return "product_type";
  if (facet === "tag") return "tags";
  if (facet.startsWith("option.") && facet.length > "option.".length)
    return optionAttribute(facet.slice("option.".length));
  return undefined;
}

/** Whether a facet's value is the same on every document of a product. */
function productLevel(facet: string): boolean {
  return facet === "vendor" || facet === "product_type" || facet === "tag";
}

/** What `group` collapses on; `undefined` for one hit per variant. */
export function distinctFor(group: SearchRequest["group"]): string | undefined {
  if (group === "variant") return undefined;
  if (group === "product") return "product";
  // `listing`, and any group a newer Hypha sends.
  return "listing";
}

/** Meilisearch's `sort` for the request: the sort's key, then Hypha's tie-breaks. */
export function sortFor(request: SearchRequest): string[] {
  // Within a product group, ties go by position (Hypha's `within_group`); between
  // listings or variants, by listing key and then position (`between_groups`).
  const tail =
    request.group === "product"
      ? ["created_at:desc", "product:desc", "position:asc"]
      : ["created_at:desc", "product:desc", "listing:asc", "position:asc"];
  switch (request.sort) {
    case "price_asc":
      return ["price:asc", ...tail];
    case "price_desc":
      return ["price:desc", ...tail];
    case "title":
      return ["title_sort:asc", ...tail];
    // `newest`, `relevance` (ranked by Meilisearch first, these break its ties; without
    // words it is `newest`) and any sort a newer Hypha sends.
    default:
      return tail;
  }
}

/**
 * The filter expressions (all must hold) for the request, leaving out the filters on
 * `except`; `undefined` when a filter can't match anything (no values, or a facet no
 * document has), as Hypha's reference treats them.
 */
export function filterFor(request: SearchRequest, except?: string): string[] | undefined {
  const out: string[] = [];
  if (request.channel) out.push(`channels = ${quote(request.channel)}`);
  if (request.category) out.push(`categories = ${quote(request.category)}`);
  if (request.available === true || request.available === false)
    out.push(`available = ${request.available}`);
  const min = request.price?.min;
  const max = request.price?.max;
  if (typeof min === "number") out.push(`price >= ${Math.trunc(min)}`);
  if (typeof max === "number") out.push(`price <= ${Math.trunc(max)}`);
  for (const filter of request.filters ?? []) {
    if (filter.facet === except) continue;
    const attribute = facetAttribute(filter.facet);
    if (!attribute || filter.values.length === 0) return undefined;
    out.push(`${quoteAttribute(attribute)} IN [${filter.values.map(quote).join(", ")}]`);
  }
  return out;
}

/** Attribute names are quoted too: they're safe already, but this keeps them literal. */
function quoteAttribute(attribute: string): string {
  return quote(attribute);
}

/** How one asked-for facet is counted. */
export type FacetPlan =
  | { facet: string; kind: "none" }
  /** In the count query's distribution (no filter of its own). */
  | { facet: string; kind: "count"; attribute: string }
  /** Its own query, without its filter; `exact` when its groups are counted per value. */
  | { facet: string; kind: "own"; attribute: string; query: MeiliSearchQuery; exact: boolean };

export interface SearchPlan {
  index: string;
  /** A filter can't match: no hits, total 0 (facets may still count). */
  empty: boolean;
  hits: MeiliSearchQuery;
  count: MeiliSearchQuery;
  facets: FacetPlan[];
}

/** The Meilisearch queries that answer `request` on `index`. */
export function planSearch(index: string, request: SearchRequest): SearchPlan {
  const q = request.query.trim();
  const distinct = distinctFor(request.group);
  const grouped = distinct !== undefined;
  const sort = sortFor(request);
  const filter = filterFor(request);
  const base = (f: string[] | undefined): MeiliSearchQuery => ({
    indexUid: index,
    q,
    filter: f ?? [],
    ...(distinct ? { distinct } : {}),
  });

  const facets: FacetPlan[] = [];
  const countFacets: string[] = [];
  for (const facet of request.facets ?? []) {
    const attribute = facetAttribute(facet);
    if (!attribute) {
      facets.push({ facet, kind: "none" });
      continue;
    }
    const exact = grouped && !productLevel(facet);
    const ownFilter = (request.filters ?? []).some((f) => f.facet === facet);
    if (!exact && !ownFilter && filter !== undefined) {
      facets.push({ facet, kind: "count", attribute });
      countFacets.push(attribute);
      continue;
    }
    const without = filterFor(request, facet);
    if (without === undefined) {
      facets.push({ facet, kind: "none" });
      continue;
    }
    const query: MeiliSearchQuery = {
      indexUid: index,
      q,
      filter: without,
      facets: [attribute],
      page: 1,
      hitsPerPage: 0,
      // Exact counting reads documents' values first, then counts groups per value.
      ...(distinct && !exact ? { distinct } : {}),
    };
    facets.push({ facet, kind: "own", attribute, query, exact });
  }

  return {
    index,
    empty: filter === undefined,
    hits: {
      ...base(filter),
      sort,
      offset: request.offset,
      limit: request.limit,
      attributesToRetrieve: ["product", "variant"],
    },
    count: {
      ...base(filter),
      page: 1,
      hitsPerPage: 0,
      ...(countFacets.length > 0 ? { facets: countFacets } : {}),
    },
    facets,
  };
}

/** For an exact facet: one query per value seen more than once, counting its groups. */
export function exactCountQueries(
  plan: SearchPlan,
  request: SearchRequest,
  facet: Extract<FacetPlan, { kind: "own" }>,
  documentCounts: Record<string, number>,
): { value: string; query: MeiliSearchQuery }[] {
  const distinct = distinctFor(request.group);
  return topValues(documentCounts)
    .filter(([, count]) => count > 1)
    .map(([value]) => ({
      value,
      query: {
        indexUid: plan.index,
        q: facet.query.q ?? "",
        filter: [...(facet.query.filter ?? []), `${quote(facet.attribute)} = ${quote(value)}`],
        page: 1,
        hitsPerPage: 0,
        ...(distinct ? { distinct } : {}),
      },
    }));
}

/** Most first, then by value; at most `MAX_FACET_VALUES`. */
function topValues(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .toSorted(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_FACET_VALUES);
}

function facetCounts(facet: string, counts: Record<string, number> | undefined): FacetCounts {
  return {
    facet,
    values: topValues(counts ?? {}).map(([value, count]) => ({ value, count })),
  };
}

/** Phase one's results, by query. */
export interface PhaseOne {
  hits: MeiliSearchResult | undefined;
  count: MeiliSearchResult | undefined;
  /** The results of `plan.facets`' own queries, by facet. */
  own: ReadonlyMap<string, MeiliSearchResult>;
}

/** The point's answer from the queries' results. */
export function answer(
  plan: SearchPlan,
  request: SearchRequest,
  results: PhaseOne,
  exact: ReadonlyMap<string, Record<string, number>>,
): SearchResponse {
  const hits = plan.empty
    ? []
    : (results.hits?.hits ?? []).slice(0, request.limit).flatMap((hit) => {
        const product = hit.product;
        const variant = hit.variant;
        if (typeof product !== "string") return [];
        return [{ product, variant: typeof variant === "string" ? variant : null }];
      });
  const total = plan.empty
    ? 0
    : (results.count?.totalHits ?? results.count?.estimatedTotalHits ?? 0);
  const facets = plan.facets.map((facet): FacetCounts => {
    switch (facet.kind) {
      case "none":
        return { facet: facet.facet, values: [] };
      case "count":
        return facetCounts(facet.facet, results.count?.facetDistribution?.[facet.attribute]);
      case "own":
        return facetCounts(
          facet.facet,
          facet.exact
            ? exact.get(facet.facet)
            : results.own.get(facet.facet)?.facetDistribution?.[facet.attribute],
        );
    }
  });
  return { hits, total, facets };
}

/** Runs the plan: one multi-search, and a second for exact option counts when needed. */
export async function search(
  meili: MeiliClient,
  index: string,
  request: SearchRequest,
  timeoutMs?: number,
): Promise<SearchResponse> {
  const plan = planSearch(index, request);
  const own = plan.facets.filter((f) => f.kind === "own");
  const queries = [...(plan.empty ? [] : [plan.hits, plan.count]), ...own.map((f) => f.query)];
  const first = queries.length > 0 ? await meili.multiSearch(queries, timeoutMs) : [];
  const offset = plan.empty ? 0 : 2;
  const phaseOne: PhaseOne = {
    hits: plan.empty ? undefined : first[0],
    count: plan.empty ? undefined : first[1],
    own: new Map(
      own.flatMap((f, i) => {
        const result = first[offset + i];
        return result ? [[f.facet, result] as const] : [];
      }),
    ),
  };

  const exact = new Map<string, Record<string, number>>();
  const second: { facet: string; value: string; query: MeiliSearchQuery }[] = [];
  for (const facet of own) {
    if (!facet.exact) continue;
    const documents = phaseOne.own.get(facet.facet)?.facetDistribution?.[facet.attribute] ?? {};
    // A value on one document is on one group; the rest are counted.
    const counts: Record<string, number> = {};
    for (const [value, n] of Object.entries(documents)) if (n === 1) counts[value] = 1;
    exact.set(facet.facet, counts);
    for (const { value, query } of exactCountQueries(plan, request, facet, documents))
      second.push({ facet: facet.facet, value, query });
  }
  if (second.length > 0) {
    const counted = await meili.multiSearch(
      second.map((s) => s.query),
      timeoutMs,
    );
    for (const [i, { facet, value }] of second.entries()) {
      const counts = exact.get(facet);
      if (counts) counts[value] = counted[i]?.totalHits ?? 0;
    }
  }
  return answer(plan, request, phaseOne, exact);
}
