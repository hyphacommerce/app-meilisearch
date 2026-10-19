// What each Hypha event means for the index (design note 0019, §5's table, as
// `hypha_search::SearchIndexer` reads it): marks of what to rebuild. Marks coalesce, so
// a busy product is rebuilt once however many events it had, and the rebuild reads the
// current state, so deliveries arriving out of order do no harm.

/** Targets and their priority (lower first). Caches are rebuilt before products. */
export const PRIORITY = {
  /** `all`, `catalog:<id>`, `price_list:<id>`: refresh a cache (or everything). */
  cache: 0,
  /** `products_from:<cursor>`, `category:<id>`, `variant:<id>`: find products to mark. */
  expand: 1,
  /** `product:<id>`. */
  product: 4,
} as const;

export interface MarkTarget {
  target: string;
  priority: number;
}

export const all = (): MarkTarget => ({ target: "all", priority: PRIORITY.cache });
export const product = (id: string): MarkTarget => ({
  target: `product:${id}`,
  priority: PRIORITY.product,
});
export const variant = (id: string): MarkTarget => ({
  target: `variant:${id}`,
  priority: PRIORITY.expand,
});
export const catalog = (id: string): MarkTarget => ({
  target: `catalog:${id}`,
  priority: PRIORITY.cache,
});
export const priceList = (id: string): MarkTarget => ({
  target: `price_list:${id}`,
  priority: PRIORITY.cache,
});
export const category = (id: string): MarkTarget => ({
  target: `category:${id}`,
  priority: PRIORITY.expand,
});
export const productsFrom = (cursor: string): MarkTarget => ({
  target: `products_from:${cursor}`,
  priority: PRIORITY.expand,
});

/** An event as Hypha delivers it (design note 0016, EV5). */
export interface EventEnvelope {
  id: string;
  type: string;
  version: number;
  subject: { type: string; id: string; version?: number | null };
  occurred_at: string;
  data: Record<string, unknown>;
}

export class PayloadError extends Error {
  constructor(type: string, field: string) {
    super(`${type}: \`${field}\` isn't what the event promises`);
    this.name = "PayloadError";
  }
}

function text(event: EventEnvelope, field: string): string {
  const value = event.data[field];
  if (typeof value !== "string" || value === "") throw new PayloadError(event.type, field);
  return value;
}

function texts(event: EventEnvelope, field: string): string[] {
  const value = event.data[field];
  if (!Array.isArray(value)) throw new PayloadError(event.type, field);
  const out: string[] = [];
  for (const v of value as unknown[]) {
    if (typeof v !== "string") throw new PayloadError(event.type, field);
    out.push(v);
  }
  return out;
}

function fields(event: EventEnvelope): string[] | undefined {
  const value = event.data.fields;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

/** Whether the event's `fields` name any of `names` (an event without `fields` does). */
function changed(event: EventEnvelope, names: readonly string[]): boolean {
  const list = fields(event);
  return list === undefined || list.some((f) => names.includes(f));
}

/** The marks an event makes; a payload that isn't what its type promises throws. */
export function marksFor(event: EventEnvelope): MarkTarget[] {
  switch (event.type) {
    case "product.created":
    case "product.updated":
    case "product.variant_added":
    case "product.variant_updated":
    case "product.variant_removed":
      return [product(text(event, "product"))];
    case "catalog.products_added":
    case "catalog.products_removed":
      // The catalog's copy is refreshed whole (deliveries may come out of order).
      return [catalog(text(event, "catalog")), ...texts(event, "products").map(product)];
    case "price_list.prices_set":
    case "price_list.prices_removed":
      return [priceList(text(event, "price_list")), ...texts(event, "variants").map(variant)];
    case "inventory_item.changed":
    case "inventory_item.deleted":
      return [variant(text(event, "variant"))];
    case "channel.products_published":
    case "channel.products_unpublished":
    case "category.products_added":
    case "category.products_removed":
    case "category.deleted":
      return texts(event, "products").map(product);
    case "category.changed":
      return changed(event, ["parent", "visible"]) ? [category(text(event, "category"))] : [];
    // Rare and wide: which products a market sells, at what price, from where.
    case "catalog.changed":
    case "price_list.changed":
      return [all()];
    case "market.changed":
      return changed(event, ["created", "countries", "currency", "prices_include_tax", "catalog"])
        ? [all()]
        : [];
    case "location.changed":
      return changed(event, ["created", "markets"]) ? [all()] : [];
    case "search_settings.changed":
      return changed(event, ["split_by"]) ? [all()] : [];
    default:
      // `channel.changed` (names aren't in documents), and anything newer.
      return [];
  }
}
