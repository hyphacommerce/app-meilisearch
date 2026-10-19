// Keeping each market's index in step with Hypha (design note 0029, §9; 0019, §5's job):
// the webhooks mark what changed (`events.ts`), and steps work the marks, most urgent
// first: refreshing the caches (`all`, a catalog, a price list), finding the products
// to rebuild (a page of every product, a category's subtree, a variant's product),
// then rebuilding a batch of products in every market. A step does one bounded piece
// and says whether there's more, so a Worker's cron, `waitUntil` and Node's interval
// can all drive it.

import type { AppContext } from "./context.ts";
import {
  CategoryTree,
  type InventoryItem,
  type Location,
  type MarketContext,
  type Money,
  type SearchDocument,
  buildDocuments,
  expandCategories,
} from "./documents.ts";
import { PRIORITY, all, product as productMark, productsFrom } from "./events.ts";
import { HyphaReader } from "./hypha.ts";
import { INDEX_SETTINGS, indexName, settingsHash } from "./index-settings.ts";
import { meiliFor, readerFor } from "./installations.ts";
import { type MeiliClient, quote } from "./meili.ts";
import type { InstallationRow, Mark } from "./storage.ts";

export interface StepResult {
  /** Another step has work now. */
  more: boolean;
  /** What this step did, for logs and tests. */
  did: "nothing" | "not_configured" | "caches" | "expanded" | "products" | "failed";
  marks: number;
}

/** What every product's documents in a store need, loaded once per step. */
export interface StoreContext {
  markets: MarketContext[];
  /** Locations by market they serve. */
  serving: Map<string, Location[]>;
  tree: CategoryTree;
  splitBy: string[];
}

export async function loadStoreContext(reader: HyphaReader): Promise<StoreContext> {
  const [markets, lists, locations, categories, settings] = await Promise.all([
    reader.markets(),
    reader.priceLists(),
    reader.locations(),
    reader.categories(),
    reader.searchSettings(),
  ]);
  const byId = new Map(lists.map((l) => [l.id, l]));
  const contexts = await Promise.all(
    markets.map(async (market): Promise<MarketContext> => {
      if (!market.catalog)
        return { id: market.id, currency: market.currency, catalog: null, priceList: null };
      const catalog = await reader.catalog(market.catalog);
      const listId = catalog.price_list ?? null;
      const list = listId ? byId.get(listId) : undefined;
      return {
        id: market.id,
        currency: market.currency,
        catalog: catalog.id,
        priceList:
          listId === null
            ? null
            : list
              ? { id: list.id, currency: list.currency, adjustmentBps: list.adjustment_bps }
              : "missing",
      };
    }),
  );
  const serving = new Map<string, Location[]>();
  for (const location of locations)
    for (const market of location.markets)
      serving.set(market, [...(serving.get(market) ?? []), location]);
  return {
    markets: contexts,
    serving,
    tree: new CategoryTree(categories),
    splitBy: settings.split_by,
  };
}

/** Gives each market's index its settings, once per settings version. */
async function ensureIndexes(
  ctx: AppContext,
  row: InstallationRow,
  meili: MeiliClient,
  markets: readonly MarketContext[],
): Promise<Map<string, string>> {
  const hash = await settingsHash();
  const known = new Map((await ctx.storage.indexes(row.store)).map((i) => [i.market, i]));
  const uids = new Map<string, string>();
  for (const market of markets) {
    const uid = indexName(row.index_prefix, row.store, market.id);
    uids.set(market.id, uid);
    const index = known.get(market.id);
    if (index?.uid === uid && index.settings_hash === hash) continue;
    await meili.updateSettings(uid, INDEX_SETTINGS);
    await ctx.storage.saveIndex(row.store, { market: market.id, uid, settings_hash: hash });
  }
  return uids;
}

/** Refreshes the copies of a catalog's products or a price list's fixed prices. */
async function refreshCache(
  ctx: AppContext,
  store: string,
  reader: HyphaReader,
  target: string,
): Promise<void> {
  const [kind, id = ""] = splitTarget(target);
  if (kind === "catalog") {
    await ctx.storage.replaceCatalogProducts(store, id, await reader.catalogProducts(id));
  } else if (kind === "price_list") {
    const prices = await reader.fixedPrices(id);
    await ctx.storage.replaceFixedPrices(
      store,
      id,
      prices.map((p) => ({
        variant: p.variant,
        amount: p.price.amount,
        currency: p.price.currency,
      })),
    );
  }
}

/** `all`: every cache refreshed, every index set up, every product marked page by page. */
async function rebuildEverything(
  ctx: AppContext,
  row: InstallationRow,
  reader: HyphaReader,
  meili: MeiliClient,
): Promise<void> {
  const context = await loadStoreContext(reader);
  await ensureIndexes(ctx, row, meili, context.markets);
  const catalogs = new Set<string>();
  const lists = new Set<string>();
  for (const market of context.markets) {
    if (market.catalog) catalogs.add(market.catalog);
    if (market.priceList && market.priceList !== "missing") lists.add(market.priceList.id);
  }
  for (const id of catalogs) await refreshCache(ctx, row.store, reader, `catalog:${id}`);
  for (const id of lists) await refreshCache(ctx, row.store, reader, `price_list:${id}`);
  await ctx.storage.mark(row.store, [productsFrom("")], ctx.now());
}

function splitTarget(target: string): [string, string | undefined] {
  const at = target.indexOf(":");
  return at < 0 ? [target, undefined] : [target.slice(0, at), target.slice(at + 1)];
}

/** Finds the products a mark stands for and marks them. */
async function expand(
  ctx: AppContext,
  store: string,
  reader: HyphaReader,
  mark: Mark,
): Promise<void> {
  const [kind, id = ""] = splitTarget(mark.target);
  const now = ctx.now();
  if (kind === "products_from") {
    const page = await reader.productIds(id === "" ? undefined : id);
    await ctx.storage.mark(
      store,
      [...page.ids.map(productMark), ...(page.next ? [productsFrom(page.next)] : [])],
      now,
    );
  } else if (kind === "category") {
    const tree = new CategoryTree(await reader.categories());
    const products = new Set<string>();
    for (const category of tree.has(id) ? tree.subtree(id) : [id])
      for (const p of await reader.categoryProducts(category)) products.add(p);
    await ctx.storage.mark(store, [...products].map(productMark), now);
  } else if (kind === "variant") {
    // A variant no product here has is new: its product's own event rebuilds it.
    const products = await ctx.storage.productsOfVariants(store, [id]);
    await ctx.storage.mark(store, products.map(productMark), now);
  }
}

/** What one product needs besides the store's context. */
interface LoadedProduct {
  id: string;
  product: Awaited<ReturnType<HyphaReader["product"]>>;
  stock: Map<string, InventoryItem>;
  catalogs: Set<string>;
  /** Fixed prices by price list, by variant. */
  fixed: Map<string, Map<string, Money>>;
}

async function loadProduct(
  ctx: AppContext,
  store: string,
  reader: HyphaReader,
  context: StoreContext,
  id: string,
): Promise<LoadedProduct> {
  const [product, inventory, catalogs] = await Promise.all([
    reader.product(id),
    reader.productInventory(id),
    ctx.storage.catalogsWith(store, id),
  ]);
  const fixed = new Map<string, Map<string, Money>>();
  const variants = product?.variants.map((v) => v.id) ?? [];
  for (const market of context.markets) {
    const list = market.priceList;
    if (!list || list === "missing" || fixed.has(list.id) || variants.length === 0) continue;
    const prices = await ctx.storage.fixedPrices(store, list.id, variants);
    fixed.set(
      list.id,
      new Map(prices.map((p) => [p.variant, { amount: p.amount, currency: p.currency }])),
    );
  }
  return {
    id,
    product,
    stock: new Map(inventory.map((item) => [item.variant, item])),
    catalogs: new Set(catalogs),
    fixed,
  };
}

/** A product's documents per market (none where it isn't sold, or when it's gone). */
export function documentsByMarket(
  loaded: LoadedProduct,
  context: StoreContext,
): Map<string, SearchDocument[]> {
  const out = new Map<string, SearchDocument[]>();
  const categories = loaded.product
    ? expandCategories(loaded.product.categories, context.tree)
    : [];
  for (const market of context.markets) {
    if (!loaded.product) {
      out.set(market.id, []);
      continue;
    }
    const list = market.priceList;
    out.set(
      market.id,
      buildDocuments({
        product: loaded.product,
        market,
        pricing: {
          inCatalog: market.catalog !== null && loaded.catalogs.has(market.catalog),
          fixed: (list && list !== "missing" && loaded.fixed.get(list.id)) || new Map(),
        },
        stock: { items: loaded.stock, locations: context.serving.get(market.id) ?? [] },
        splitBy: context.splitBy,
        categories,
      }),
    );
  }
  return out;
}

/** The filter removing a product's documents except `keep`. */
export function staleFilter(product: string, keep: readonly string[]): string {
  return keep.length === 0
    ? `product = ${quote(product)}`
    : `(product = ${quote(product)} AND variant NOT IN [${keep.map(quote).join(", ")}])`;
}

/** Rebuilds `ids` in every market: adds or replaces their documents, removes the rest. */
async function rebuildProducts(
  ctx: AppContext,
  row: InstallationRow,
  reader: HyphaReader,
  meili: MeiliClient,
  ids: readonly string[],
): Promise<void> {
  const context = await loadStoreContext(reader);
  const uids = await ensureIndexes(ctx, row, meili, context.markets);
  const loaded = await Promise.all(
    ids.map((id) => loadProduct(ctx, row.store, reader, context, id)),
  );
  for (const market of context.markets) {
    const uid = uids.get(market.id) ?? indexName(row.index_prefix, row.store, market.id);
    const add: SearchDocument[] = [];
    const stale: string[] = [];
    for (const product of loaded) {
      const documents = documentsByMarket(product, context).get(market.id) ?? [];
      add.push(...documents);
      stale.push(
        staleFilter(
          product.id,
          documents.map((d) => d.id),
        ),
      );
    }
    if (add.length > 0) await meili.addDocuments(uid, add);
    for (let i = 0; i < stale.length; i += 20)
      await meili.deleteByFilter(uid, stale.slice(i, i + 20).join(" OR "));
  }
  for (const product of loaded)
    await ctx.storage.setVariants(
      row.store,
      product.id,
      product.product?.variants.map((v) => v.id) ?? [],
    );
}

/** One step of the store's work. */
export async function step(ctx: AppContext, store: string): Promise<StepResult> {
  const row = await ctx.storage.getInstallation(store);
  if (!row) return { more: false, did: "nothing", marks: 0 };
  const meili = await meiliFor(ctx, row);
  if (!meili) return { more: false, did: "not_configured", marks: 0 };
  const lease = (range: readonly [number, number], limit: number) =>
    ctx.storage.lease(store, range, limit, ctx.now(), ctx.config.leaseMs);
  const cacheRange = [PRIORITY.cache, PRIORITY.cache] as const;

  let leased: Mark[] = [];
  let did: StepResult["did"] = "nothing";
  try {
    leased = await lease(cacheRange, 5);
    if (leased.length > 0) {
      did = "caches";
      const reader = readerFor(ctx, row);
      for (const mark of leased) {
        if (mark.target === "all") await rebuildEverything(ctx, row, reader, meili);
        else await refreshCache(ctx, store, reader, mark.target);
        await ctx.storage.finish(store, mark);
      }
      if ((await ctx.storage.countMarks(store, cacheRange)) === 0)
        await ctx.storage.updateInstallation(store, { caches_ready: 1, last_error: null });
      return { more: true, did, marks: leased.length };
    }
    // Another runner is refreshing a cache: products wait for it.
    if ((await ctx.storage.countMarks(store, cacheRange)) > 0)
      return { more: false, did: "nothing", marks: 0 };
    if (!row.caches_ready) {
      await ctx.storage.mark(store, [all()], ctx.now());
      return { more: true, did: "nothing", marks: 0 };
    }

    leased = await lease([PRIORITY.expand, PRIORITY.expand], 5);
    if (leased.length > 0) {
      did = "expanded";
      const reader = readerFor(ctx, row);
      for (const mark of leased) {
        await expand(ctx, store, reader, mark);
        await ctx.storage.finish(store, mark);
      }
      return { more: true, did, marks: leased.length };
    }

    leased = await lease([PRIORITY.product, PRIORITY.product], ctx.config.batch);
    if (leased.length === 0) return { more: false, did: "nothing", marks: 0 };
    did = "products";
    const reader = readerFor(ctx, row);
    await rebuildProducts(
      ctx,
      row,
      reader,
      meili,
      leased.map((m) => splitTarget(m.target)[1] ?? ""),
    );
    for (const mark of leased) await ctx.storage.finish(store, mark);
    const left = await ctx.storage.countMarks(store);
    if (left === 0)
      await ctx.storage.updateInstallation(store, { last_reindex_at: ctx.now(), last_error: null });
    return { more: left > 0, did, marks: leased.length };
  } catch (error) {
    // The marks stay leased until their lease runs out: a later step tries again.
    const message = error instanceof Error ? error.message : String(error);
    ctx.log("indexing failed", { store, did, error: message });
    await ctx.storage.updateInstallation(store, { last_error: message.slice(0, 500) });
    return { more: false, did: "failed", marks: leased.length };
  }
}

/** Steps through every store with due work until there's none or `deadline` passes. */
export async function runDue(ctx: AppContext, deadline: number): Promise<number> {
  let steps = 0;
  const stores = await ctx.storage.storesWithDueMarks(ctx.now());
  for (const store of stores) {
    for (;;) {
      if (ctx.now() >= deadline) return steps;
      const result = await step(ctx, store);
      steps++;
      if (!result.more) break;
    }
  }
  return steps;
}
