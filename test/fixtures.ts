// Admin API responses as Hypha answers them, for building documents and faking the API.

import type { InventoryItem, Location, Product } from "../src/core/documents.ts";

export const hex = (n: number) => n.toString(16).padStart(32, "0");
export const id = (prefix: string, n: number) => `${prefix}_${hex(n)}`;

export const MARKET_EU = id("mkt", 1);
export const MARKET_UK = id("mkt", 2);
export const CATALOG_EU = id("cat", 1);
export const CATALOG_UK = id("cat", 2);
export const LIST_UK = id("pl", 1);
export const LOCATION_EU = id("loc", 1);
export const LOCATION_UK = id("loc", 2);
export const CHANNEL = id("chan", 1);

export interface VariantSpec {
  n: number;
  price: number;
  currency?: string;
  /** Option value labels, in option order. */
  values: string[];
  sku?: string;
}

/** A product with options and variants; option value IDs are derived from labels. */
export function product(spec: {
  n: number;
  title: string;
  status?: "active" | "draft" | "archived";
  created: string;
  options?: { name: string; values: string[] }[];
  variants: VariantSpec[];
  vendor?: string | null;
  product_type?: string | null;
  tags?: string[];
  categories?: string[];
  channels?: string[];
  description?: string | null;
}): Product {
  const options = (spec.options ?? []).map((option, o) => ({
    id: id("opt", spec.n * 100 + o),
    name: option.name,
    values: option.values.map((label, v) => ({
      id: id("optv", spec.n * 10_000 + o * 100 + v),
      label,
    })),
  }));
  return {
    id: id("prod", spec.n),
    handle: spec.title.toLowerCase().replaceAll(" ", "-"),
    custom_fields: {},
    title: spec.title,
    status: spec.status ?? "active",
    created_at: spec.created,
    updated_at: spec.created,
    description: spec.description ?? null,
    vendor: spec.vendor ?? null,
    product_type: spec.product_type ?? null,
    tags: spec.tags ?? [],
    categories: spec.categories ?? [],
    custom_fields: {},
    channels: spec.channels ?? [CHANNEL],
    media: [],
    options,
    variants: spec.variants.map((variant) => ({
      id: id("var", variant.n),
      custom_fields: {},
      price: { amount: variant.price, currency: variant.currency ?? "EUR" },
      requires_shipping: true,
      selections: variant.values.map((label, o) => {
        const value = options[o]?.values.find((v) => v.label === label);
        if (!value) throw new Error(`no value ${label}`);
        return value.id;
      }),
      sku: variant.sku ?? null,
      title: variant.values.length > 0 ? variant.values.join(" / ") : null,
      weight_grams: null,
      custom_fields: {},
    })),
  };
}

export function item(
  variant: number,
  levels: [string, number][],
  { tracked = true, continueSelling = false } = {},
): InventoryItem {
  return {
    id: id("inv", variant),
    variant: id("var", variant),
    tracked,
    continue_selling: continueSelling,
    levels: levels.map(([location, available]) => ({
      location,
      available,
      on_hand: available,
      reserved: 0,
    })),
  };
}

export function stockLocation(n: string, markets: string[], priority = 0): Location {
  return { id: n, name: n, markets, priority, address: null };
}

/** A shirt in red and blue, S and M (not blue M), a mug, and a draft. */
export function catalogue(): Product[] {
  return [
    product({
      n: 1,
      title: "Linen Shirt",
      created: "2026-01-02T00:00:00Z",
      vendor: "Loom",
      product_type: "Shirts",
      tags: ["Summer", "Linen"],
      categories: [id("pcat", 2)],
      description: "<p>Light <strong>linen</strong> &amp; airy</p>",
      options: [
        { name: "Color", values: ["Red", "Blue"] },
        { name: "Size", values: ["S", "M"] },
      ],
      variants: [
        { n: 11, price: 4000, values: ["Red", "S"], sku: "LS-RED-S" },
        { n: 12, price: 4200, values: ["Red", "M"], sku: "LS-RED-M" },
        { n: 13, price: 3800, values: ["Blue", "S"], sku: "LS-BLUE-S" },
      ],
    }),
    product({
      n: 2,
      title: "Stoneware Mug",
      created: "2026-01-03T00:00:00Z",
      vendor: "Kiln",
      product_type: "Mugs",
      tags: ["Kitchen"],
      options: [{ name: "colour", values: ["Red"] }],
      variants: [{ n: 21, price: 1500, values: ["Red"], sku: "MUG-RED" }],
    }),
    product({
      n: 3,
      title: "Draft Hat",
      status: "draft",
      created: "2026-01-04T00:00:00Z",
      variants: [{ n: 31, price: 900, values: [] }],
    }),
  ];
}
