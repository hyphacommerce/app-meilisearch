// Reading what search needs from Hypha's admin API, as the app (its OAuth token): the
// scopes in the manifest are exactly these routes' `x-hypha-scopes`.

import type { HyphaClient } from "@hypha/app";
import type { AdminSchemas } from "@hypha/sdk/admin";

import type { InventoryItem, Location, Money, Product } from "./documents.ts";
import { documented, stringField } from "./json.ts";

export class HyphaApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(what: string, status: number, code?: string) {
    super(`${what}: HTTP ${status}${code ? ` ${code}` : ""}`);
    this.name = "HyphaApiError";
    this.status = status;
    this.code = code;
  }
}

type Market = AdminSchemas["MarketResponse"];
type PriceList = AdminSchemas["PriceListResponse"];
type CategoryNode = AdminSchemas["CategoryNode"];

interface Page<T> {
  items: T[];
  has_more: boolean;
  next_cursor?: string | null;
}

/** The pages of a list route, followed to the end. */
async function all<T>(read: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await read(cursor);
    out.push(...page.items);
    if (!page.has_more || !page.next_cursor) return out;
    cursor = page.next_cursor;
  }
}

export class HyphaReader {
  readonly #client: HyphaClient;
  constructor(client: HyphaClient) {
    this.#client = client;
  }

  async #get<T>(what: string, path: string, query: Record<string, string | undefined> = {}) {
    const url = new URL(path, this.#client.apiUrl);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, value);
    const response = await this.#client.fetch(url.pathname + url.search);
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      throw new HyphaApiError(what, response.status, stringField(body, "code"));
    }
    return documented<T>(response);
  }

  async adminOrigins(): Promise<string[]> {
    const body = await this.#get<AdminSchemas["OriginsResponse"]>(
      "the admin origins",
      "/admin/app-extensions/origins",
    );
    return body.origins;
  }

  async markets(): Promise<Market[]> {
    return (await this.#get<AdminSchemas["MarketListResponse"]>("markets", "/admin/markets")).items;
  }

  async catalog(id: string): Promise<AdminSchemas["CatalogResponse"]> {
    return this.#get(`catalog ${id}`, `/admin/catalogs/${id}`);
  }

  async priceLists(): Promise<PriceList[]> {
    return (
      await this.#get<AdminSchemas["PriceListListResponse"]>("price lists", "/admin/price-lists")
    ).items;
  }

  async locations(): Promise<Location[]> {
    return (await this.#get<AdminSchemas["LocationList"]>("locations", "/admin/locations")).items;
  }

  async categories(): Promise<CategoryNode[]> {
    return (
      await this.#get<AdminSchemas["CategoryTreeResponse"]>("categories", "/admin/categories")
    ).items;
  }

  async searchSettings(): Promise<AdminSchemas["SearchSettingsResponse"]> {
    return this.#get("search settings", "/admin/search/settings");
  }

  /** `undefined` when there's no such product. */
  async product(id: string): Promise<Product | undefined> {
    try {
      return await this.#get<Product>(`product ${id}`, `/admin/products/${id}`);
    } catch (error) {
      if (error instanceof HyphaApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async productInventory(id: string): Promise<InventoryItem[]> {
    try {
      const body = await this.#get<AdminSchemas["ProductInventoryResponse"]>(
        `product ${id}'s inventory`,
        `/admin/products/${id}/inventory`,
      );
      return body.items;
    } catch (error) {
      if (error instanceof HyphaApiError && error.status === 404) return [];
      throw error;
    }
  }

  /** One page of every product's ID (any status), and where the next starts. */
  async productIds(cursor: string | undefined): Promise<{ ids: string[]; next: string | null }> {
    const page = await this.#get<AdminSchemas["ProductSummaryPage"]>(
      "products",
      "/admin/products",
      {
        limit: "100",
        cursor,
      },
    );
    return {
      ids: page.items.map((p) => p.id),
      next: page.has_more ? (page.next_cursor ?? null) : null,
    };
  }

  async catalogProducts(id: string): Promise<string[]> {
    const items = await all((cursor) =>
      this.#get<AdminSchemas["CatalogProductPage"]>(
        `catalog ${id}'s products`,
        `/admin/catalogs/${id}/products`,
        {
          limit: "100",
          cursor,
        },
      ),
    );
    return items.map((item) => item.id);
  }

  async fixedPrices(id: string): Promise<{ variant: string; price: Money }[]> {
    const items = await all((cursor) =>
      this.#get<AdminSchemas["FixedPricePage"]>(
        `price list ${id}'s prices`,
        `/admin/price-lists/${id}/fixed-prices`,
        {
          limit: "100",
          cursor,
        },
      ),
    );
    return items.map((item) => ({ variant: item.variant, price: item.price }));
  }

  async categoryProducts(id: string): Promise<string[]> {
    try {
      const items = await all((cursor) =>
        this.#get<AdminSchemas["CategoryProductPage"]>(
          `category ${id}'s products`,
          `/admin/categories/${id}/products`,
          { limit: "100", cursor },
        ),
      );
      return items.map((item) => item.id);
    } catch (error) {
      if (error instanceof HyphaApiError && error.status === 404) return [];
      throw error;
    }
  }
}
