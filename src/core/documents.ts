// Search documents (design note 0019, §3, SE3/SE4), built the way Hypha builds its own:
// one document per variant per market, for active products in the market's catalog
// whose price resolves in the market's currency, with availability from the locations
// serving the market. Each document carries its `product`, `listing` and `variant`
// keys, so a query chooses its group (Meilisearch's `distinct`).
//
// Pure functions over the admin API's responses: `indexer.ts` loads the inputs.

import type { AdminSchemas } from "@hyphacommerce/sdk/admin";

import { toHex, utf8 } from "./crypto.ts";

export type Product = AdminSchemas["ProductResponse"];
export type Variant = AdminSchemas["VariantResponse"];
export type InventoryItem = AdminSchemas["InventoryResponse"];
export type Location = AdminSchemas["LocationResponse"];
export type Money = AdminSchemas["Money"];

/** One variant of one active product, as a shopper in one market sees it. */
export interface SearchDocument {
  /** The variant's ID: Meilisearch's primary key. */
  id: string;
  product: string;
  variant: string;
  /** The product ID, then `|name=value` per split option (Hypha's `listing_key`). */
  listing: string;
  /** The channels the product is published to, sorted. */
  channels: string[];
  /** The product's shown categories and their ancestors, sorted. */
  categories: string[];
  handle: string;
  title: string;
  /** `title` lowercased: what `sort=title` compares. */
  title_sort: string;
  variant_title: string | null;
  /** The description's text, markup removed. */
  description: string;
  vendor: string | null;
  product_type: string | null;
  tags: string[];
  sku: string | null;
  /** Option value labels, for matching words. */
  option_values: string[];
  /** `optionAttribute(name)` → value label: the option facets. */
  opt: Record<string, string>;
  /** In the market's currency's minor units. */
  price: number;
  currency: string;
  available: boolean;
  /** The product's creation, in milliseconds: what `newest` sorts by. */
  created_at: number;
  /** The variant's place in its product: a group's representative on ties. */
  position: number;
}

/** Which products a list's adjustment reaches, as Hypha's `applies_to`. */
export type AppliesTo =
  | { type: "all" }
  | { type: "products"; products: readonly string[] }
  | { type: "categories"; categories: readonly string[] };

/** A price list live now for a shopper who isn't signed in, as pricing needs it. */
export interface LivePriceList {
  id: string;
  currency: string;
  /** `null`: the list prices only the variants it has fixed prices for. */
  adjustment: { percentBps: number; appliesTo: AppliesTo } | null;
}

/** A market as pricing needs it: its currency, catalog and the catalog's live price lists. */
export interface MarketContext {
  id: string;
  currency: string;
  /** `null`: the market sells nothing. */
  catalog: string | null;
  /**
   * The catalog's lists live now for a shopper who isn't signed in (active, within
   * their window, for everyone), oldest first. `missing` when one couldn't be read.
   */
  priceLists: LivePriceList[] | "missing";
}

export interface PricingInput {
  /** Whether the market's catalog includes the product. */
  inCatalog: boolean;
  /** The product's ID, for adjustments scoped to products. */
  product: string;
  /** The product's categories with their ancestors, hidden ones included: what a scoped adjustment matches. */
  categories: ReadonlySet<string>;
  /** Fixed prices for the product's variants, by price list, by variant. */
  fixed: ReadonlyMap<string, ReadonlyMap<string, Money>>;
}

export interface StockInput {
  /** The product's inventory items by variant; a variant without one is untracked. */
  items: ReadonlyMap<string, InventoryItem>;
  /** The locations serving the market. */
  locations: readonly Location[];
}

/** The largest amount Hypha's `Money` holds: 2^53 - 1 either way. */
export const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;

/**
 * `base` adjusted by basis points, rounded half away from zero (Hypha's `Money::adjust`),
 * in integers so no amount loses precision. `undefined` past `MAX_AMOUNT`.
 */
export function adjust(amount: number, bps: number): number | undefined {
  const scale = 10_000n;
  const numerator = BigInt(amount) * (scale + BigInt(bps));
  let result = numerator / scale;
  const remainder = numerator % scale;
  const abs = remainder < 0n ? -remainder : remainder;
  if (abs * 2n >= scale) result += numerator < 0n ? -1n : 1n;
  if (result > BigInt(MAX_AMOUNT) || result < -BigInt(MAX_AMOUNT)) return undefined;
  return Number(result);
}

/** Whether an adjustment reaches the product. */
export function covers(appliesTo: AppliesTo, pricing: PricingInput): boolean {
  if (appliesTo.type === "all") return true;
  if (appliesTo.type === "products") return appliesTo.products.includes(pricing.product);
  return appliesTo.categories.some((c) => pricing.categories.has(c));
}

/**
 * The variant's price in the market for a shopper who isn't signed in, at a quantity of
 * one (Hypha's `resolve_price`): the lowest price among the live lists that price the
 * variant (a fixed price, else the base price adjusted when the adjustment reaches the
 * product), ties to the oldest list, else the base price. `undefined` when it isn't
 * sold there: no catalog, the product isn't in it, a list couldn't be read, or a
 * currency doesn't match.
 */
export function resolvePrice(
  market: MarketContext,
  pricing: PricingInput,
  variant: string,
  base: Money,
): number | undefined {
  if (market.catalog === null || !pricing.inCatalog) return undefined;
  const lists = market.priceLists;
  if (lists === "missing") return undefined;
  let best: number | undefined;
  for (const list of lists) {
    if (list.currency !== market.currency) return undefined;
    const fixed = pricing.fixed.get(list.id)?.get(variant);
    let candidate: number | undefined;
    if (fixed) {
      if (fixed.currency !== market.currency) return undefined;
      candidate = fixed.amount;
    } else if (list.adjustment && covers(list.adjustment.appliesTo, pricing)) {
      if (base.currency !== market.currency) return undefined;
      candidate = adjust(base.amount, list.adjustment.percentBps);
      if (candidate === undefined) return undefined;
    } else continue;
    // Strictly lower: a tie keeps the older list, as Hypha's resolution does.
    if (best === undefined || candidate < best) best = candidate;
  }
  if (best !== undefined) return best;
  return base.currency === market.currency ? base.amount : undefined;
}

/**
 * Whether one of the variant can be sold in the market now (Hypha's `StockContext`
 * availability for a quantity of one): untracked, or some serving location has one
 * free, or the item sells past zero. Tracked stock with no serving location is out.
 */
export function isAvailable(variant: string, stock: StockInput): boolean {
  const item = stock.items.get(variant);
  if (!item || !item.tracked) return true;
  const seen = new Set<string>();
  const locations = stock.locations.filter((l) => !seen.has(l.id) && seen.add(l.id));
  if (locations.length === 0) return false;
  let free = 0;
  for (const location of locations) {
    const level = item.levels.find((l) => l.location === location.id);
    free += Math.max(0, level?.available ?? 0);
  }
  return free >= 1 || item.continue_selling;
}

/** Text of sanitised HTML, as Hypha's `Description::text` computes it. */
export function descriptionText(html: string | null | undefined): string {
  if (!html) return "";
  let text = "";
  let inTag = false;
  let inQuotes = false;
  for (const c of html) {
    if (!inTag) {
      if (c === "<") {
        inTag = true;
        text += " ";
      } else text += c;
    } else if (c === '"') inQuotes = !inQuotes;
    else if (c === ">" && !inQuotes) inTag = false;
  }
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/**
 * The attribute an option facet lives in: `opt.` and the hex of its lowercased name, so
 * any option name ("Shoe size", "Größe") is a safe Meilisearch attribute.
 */
export function optionAttribute(name: string): string {
  return `opt.${optionKey(name)}`;
}

export function optionKey(name: string): string {
  return toHex(utf8(name.toLowerCase()));
}

/** The product ID, then `|name=value` for each split option the variant has. */
export function listingKey(
  product: string,
  options: readonly (readonly [string, string])[],
  splitBy: readonly string[],
): string {
  let key = product;
  for (const raw of splitBy) {
    const name = raw.toLowerCase();
    const found = options.find(([n]) => n.toLowerCase() === name);
    if (found) key += `|${name}=${found[1]}`;
  }
  return key;
}

/**
 * The product's shown categories with their ancestors, sorted (design note 0022, CA3,
 * CA4): a category is shown when it and every ancestor are visible.
 */
export function expandCategories(direct: readonly string[], tree: CategoryTree): string[] {
  const out = new Set<string>();
  for (const id of direct) {
    if (!tree.isShown(id)) continue;
    out.add(id);
    for (const ancestor of tree.ancestors(id)) out.add(ancestor);
  }
  return [...out].toSorted();
}

/** The product's categories and their ancestors, hidden ones included. */
export function categoriesWithAncestors(
  direct: readonly string[],
  tree: CategoryTree,
): Set<string> {
  const out = new Set<string>();
  for (const id of direct) {
    out.add(id);
    for (const ancestor of tree.ancestors(id)) out.add(ancestor);
  }
  return out;
}

type CategoryNode = AdminSchemas["CategoryNode"];

/** The category tree as `GET /admin/categories` answers it, by parent pointer. */
export class CategoryTree {
  readonly #parent = new Map<string, string | null>();
  readonly #visible = new Map<string, boolean>();
  readonly #children = new Map<string, string[]>();

  constructor(roots: readonly CategoryNode[]) {
    const walk = (node: CategoryNode, parent: string | null) => {
      this.#parent.set(node.id, parent);
      this.#visible.set(node.id, node.visible);
      this.#children.set(
        node.id,
        node.children.map((c) => c.id),
      );
      for (const child of node.children) walk(child, node.id);
    };
    for (const root of roots) walk(root, null);
  }

  has(id: string): boolean {
    return this.#parent.has(id);
  }

  ancestors(id: string): string[] {
    const out: string[] = [];
    let current = this.#parent.get(id) ?? null;
    while (current !== null && !out.includes(current) && current !== id) {
      out.push(current);
      current = this.#parent.get(current) ?? null;
    }
    return out;
  }

  isShown(id: string): boolean {
    if (this.#visible.get(id) !== true) return false;
    return this.ancestors(id).every((a) => this.#visible.get(a) === true);
  }

  /** `id` and every category below it. */
  subtree(id: string): string[] {
    const out: string[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined || out.includes(next)) continue;
      out.push(next);
      stack.push(...(this.#children.get(next) ?? []));
    }
    return out;
  }
}

export interface BuildInput {
  product: Product;
  market: MarketContext;
  pricing: PricingInput;
  stock: StockInput;
  /** The search settings' `split_by`. */
  splitBy: readonly string[];
  /** `expandCategories` of the product's categories. */
  categories: readonly string[];
}

/** The product's documents in one market; none when it isn't sold there. */
export function buildDocuments(input: BuildInput): SearchDocument[] {
  const { product, market } = input;
  if (product.status !== "active") return [];
  const createdAt = Date.parse(product.created_at);
  const description = descriptionText(product.description);
  const channels = product.channels.toSorted();
  const documents: SearchDocument[] = [];
  for (const [position, variant] of product.variants.entries()) {
    const price = resolvePrice(market, input.pricing, variant.id, variant.price);
    if (price === undefined) continue;
    const options: [string, string][] = [];
    for (const [i, option] of product.options.entries()) {
      const selected = variant.selections[i];
      const value = option.values.find((v) => v.id === selected);
      if (value) options.push([option.name, value.label]);
    }
    const opt: Record<string, string> = {};
    for (const [name, label] of options) opt[optionKey(name)] ??= label;
    documents.push({
      id: variant.id,
      product: product.id,
      variant: variant.id,
      listing: listingKey(product.id, options, input.splitBy),
      channels,
      categories: [...input.categories],
      handle: product.handle,
      title: product.title,
      title_sort: product.title.toLowerCase(),
      variant_title: variant.title ?? null,
      description,
      vendor: product.vendor ?? null,
      product_type: product.product_type ?? null,
      tags: [...product.tags],
      sku: variant.sku ?? null,
      option_values: options.map(([, label]) => label),
      opt,
      price,
      currency: market.currency,
      available: isAvailable(variant.id, input.stock),
      created_at: Number.isFinite(createdAt) ? createdAt : 0,
      position,
    });
  }
  return documents;
}
