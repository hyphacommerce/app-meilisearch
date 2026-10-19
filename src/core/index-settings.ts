// Each market's index: its name and the Meilisearch settings that make `query.ts`'s
// searches mean what Hypha's do (design note 0019, §4).

import { sha256Hex } from "./crypto.ts";

/** At most this many hits are counted (`totalHits`); Hypha pages at most 1,000 deep. */
export const MAX_TOTAL_HITS = 10_000;
/** Values per facet, as Hypha's `MAX_FACET_VALUES`. */
export const MAX_FACET_VALUES = 100;

export const INDEX_SETTINGS = {
  // Attribute order is Meilisearch's `attribute` ranking rule: Hypha weighs titles
  // highest, then vendor, type, tags, SKU and option values, then the description.
  searchableAttributes: [
    "title",
    "variant_title",
    "vendor",
    "product_type",
    "tags",
    "sku",
    "option_values",
    "description",
  ],
  // `opt` makes every `opt.<key>` filterable and a facet; `product` and `listing` are
  // what `distinct` collapses on, so they must be filterable too.
  filterableAttributes: [
    "product",
    "variant",
    "listing",
    "channels",
    "categories",
    "available",
    "price",
    "vendor",
    "product_type",
    "tags",
    "opt",
  ],
  sortableAttributes: ["price", "created_at", "title_sort", "product", "listing", "position"],
  faceting: {
    maxValuesPerFacet: MAX_FACET_VALUES,
    // The values with the most hits, not the first alphabetically, when there are more.
    sortFacetValuesBy: { "*": "count" },
  },
  pagination: { maxTotalHits: MAX_TOTAL_HITS },
  // A SKU is typed exactly or not at all.
  typoTolerance: { disableOnAttributes: ["sku"] },
} as const;

/** Changes when `INDEX_SETTINGS` does, so existing indexes get the new settings. */
export function settingsHash(): Promise<string> {
  return sha256Hex(JSON.stringify(INDEX_SETTINGS));
}

/** `<prefix>_<store>_<market>`: Meilisearch allows letters, digits, `-` and `_`. */
export function indexName(prefix: string, store: string, market: string): string {
  return `${prefix}_${store}_${market}`;
}

/** 1 to 40 lowercase letters, digits, `-` or `_`, starting with a letter. */
export function isIndexPrefix(prefix: string): boolean {
  return /^[a-z][a-z0-9_-]{0,39}$/.test(prefix);
}
