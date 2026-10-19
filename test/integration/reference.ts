// Hypha's `hypha_search_index::reference::search` (design note 0019, §4) over this
// app's documents, for every sort but relevance (Meilisearch ranks words its own way):
// what an engine must answer. The integration test holds Meilisearch to it.

import type { SearchDocument } from "../../src/core/documents.ts";
import { optionKey } from "../../src/core/documents.ts";
import type { SearchRequest, SearchResponse } from "../../src/core/query.ts";

function facetValues(d: SearchDocument): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(d.opt)) out.push([`opt:${key}`, value]);
  if (d.vendor) out.push(["vendor", d.vendor]);
  if (d.product_type) out.push(["product_type", d.product_type]);
  for (const tag of d.tags) out.push(["tag", tag]);
  return out;
}

function keyOf(facet: string): string {
  return facet.startsWith("option.") ? `opt:${optionKey(facet.slice(7))}` : facet;
}

function groupKey(d: SearchDocument, group: string): string {
  return group === "product" ? d.product : group === "variant" ? d.variant : d.listing;
}

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

export function referenceSearch(documents: SearchDocument[], q: SearchRequest): SearchResponse {
  const inMarket = documents
    .filter((d) => !q.channel || d.channels.includes(q.channel))
    .filter((d) => !q.category || d.categories.includes(q.category))
    .filter(
      (d) => q.available === undefined || q.available === null || d.available === q.available,
    );
  const inPrice = (d: SearchDocument) =>
    (typeof q.price?.min !== "number" || d.price >= q.price.min) &&
    (typeof q.price?.max !== "number" || d.price <= q.price.max);
  const passes = (d: SearchDocument, except?: string) =>
    (q.filters ?? [])
      .filter((f) => f.facet !== except)
      .every((f) => facetValues(d).some(([k, v]) => k === keyOf(f.facet) && f.values.includes(v)));

  const matched = inMarket.filter(inPrice).filter((d) => passes(d));
  const sort = q.sort;
  const within = (a: SearchDocument, b: SearchDocument) =>
    (sort === "price_asc" ? a.price - b.price : sort === "price_desc" ? b.price - a.price : 0) ||
    cmp(a.product, b.product) ||
    a.position - b.position;
  const between = (a: SearchDocument, b: SearchDocument) =>
    (sort === "price_asc"
      ? a.price - b.price
      : sort === "price_desc"
        ? b.price - a.price
        : sort === "title"
          ? cmp(a.title.toLowerCase(), b.title.toLowerCase())
          : 0) ||
    b.created_at - a.created_at ||
    cmp(b.product, a.product) ||
    cmp(a.listing, b.listing) ||
    a.position - b.position;

  const groups = new Map<string, SearchDocument[]>();
  for (const d of matched)
    groups.set(groupKey(d, q.group), [...(groups.get(groupKey(d, q.group)) ?? []), d]);
  const representatives = [...groups.values()]
    .map((docs) => docs.toSorted(within)[0] as SearchDocument)
    .toSorted(between);

  const facets = (q.facets ?? []).map((facet) => {
    const counts = new Map<string, Set<string>>();
    for (const d of inMarket.filter(inPrice).filter((doc) => passes(doc, facet)))
      for (const [k, v] of facetValues(d))
        if (k === keyOf(facet))
          counts.set(v, (counts.get(v) ?? new Set()).add(groupKey(d, q.group)));
    const values = [...counts.entries()]
      .map(([value, set]) => ({ value, count: set.size }))
      .toSorted((a, b) => b.count - a.count || cmp(a.value, b.value))
      .slice(0, 100);
    return { facet, values };
  });

  return {
    hits: representatives
      .slice(q.offset, q.offset + q.limit)
      .map((d) => ({ product: d.product, variant: d.variant })),
    total: representatives.length,
    facets,
  };
}
