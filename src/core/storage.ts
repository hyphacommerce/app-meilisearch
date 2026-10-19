// What the app keeps (design note 0029, Q5: its own storage, not Hypha's database), as
// one small interface over SQL. Every row is keyed by the store it belongs to, so one
// deployment of the app serves any number of Hypha stores.

import type { SqlDb, SqlStatement, SqlValue } from "./sql.ts";

/** An installation as stored: secrets sealed (`Vault`), times in milliseconds. */
export interface InstallationRow {
  store: string;
  api_url: string;
  /** Space-separated, as granted. */
  scopes: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  app_secret: string;
  /** JSON array of the admin origins allowed to frame the settings page. */
  admin_origins: string;
  meili_url: string | null;
  meili_key: string | null;
  index_prefix: string;
  caches_ready: number;
  last_reindex_at: number | null;
  last_error: string | null;
  refresh_lock_until: number;
  installed_at: number;
  updated_at: number;
}

export interface OAuthState {
  state: string;
  api_url: string;
  code_verifier: string;
  created_at: number;
}

export interface Mark {
  target: string;
  generation: number;
  priority: number;
}

export interface FixedPrice {
  variant: string;
  amount: number;
  currency: string;
}

export interface IndexRow {
  market: string;
  uid: string;
  settings_hash: string;
}

export interface Storage {
  getInstallation(store: string): Promise<InstallationRow | undefined>;
  listInstallations(): Promise<InstallationRow[]>;
  /** Inserts or replaces the whole row. */
  saveInstallation(row: InstallationRow): Promise<void>;
  updateInstallation(store: string, fields: Partial<Omit<InstallationRow, "store">>): Promise<void>;
  /** Forgets the store: its installation, marks, caches and deliveries. */
  deleteStore(store: string): Promise<void>;
  /** Takes the refresh lock until `until` if nobody holds it at `now`. */
  tryLockRefresh(store: string, now: number, until: number): Promise<boolean>;
  unlockRefresh(store: string): Promise<void>;

  saveOAuthState(state: OAuthState): Promise<void>;
  /** The state, removed so it can't be used twice. */
  takeOAuthState(state: string): Promise<OAuthState | undefined>;

  /** Whether the delivery was handled (`recordDelivery`). */
  hasDelivery(store: string, delivery: string): Promise<boolean>;
  /** Records a handled delivery; `true` the first time. */
  recordDelivery(store: string, delivery: string, now: number): Promise<boolean>;
  /** Drops deliveries and authorization states older than `before`. */
  prune(before: number): Promise<void>;

  mark(
    store: string,
    targets: readonly { target: string; priority: number }[],
    now: number,
  ): Promise<void>;
  /** Leases up to `limit` due marks with a priority in `[from, to]`, most urgent first. */
  lease(
    store: string,
    range: readonly [number, number],
    limit: number,
    now: number,
    leaseMs: number,
  ): Promise<Mark[]>;
  /** Removes the mark if it wasn't marked again since leased; frees it otherwise. */
  finish(store: string, mark: Mark): Promise<void>;
  /** Marks with a priority in `[from, to]`, leased or not. */
  countMarks(store: string, range?: readonly [number, number]): Promise<number>;
  /** Stores with a mark due at `now`. */
  storesWithDueMarks(now: number): Promise<string[]>;

  replaceCatalogProducts(
    store: string,
    catalog: string,
    products: readonly string[],
  ): Promise<void>;
  /** The catalogs that include `product`. */
  catalogsWith(store: string, product: string): Promise<string[]>;
  replaceFixedPrices(
    store: string,
    priceList: string,
    prices: readonly FixedPrice[],
  ): Promise<void>;
  fixedPrices(store: string, priceList: string, variants: readonly string[]): Promise<FixedPrice[]>;
  setVariants(store: string, product: string, variants: readonly string[]): Promise<void>;
  productsOfVariants(store: string, variants: readonly string[]): Promise<string[]>;

  indexes(store: string): Promise<IndexRow[]>;
  saveIndex(store: string, row: IndexRow): Promise<void>;
  clearIndexes(store: string): Promise<void>;
}

const INSTALLATION_COLUMNS = [
  "store",
  "api_url",
  "scopes",
  "access_token",
  "refresh_token",
  "expires_at",
  "app_secret",
  "admin_origins",
  "meili_url",
  "meili_key",
  "index_prefix",
  "caches_ready",
  "last_reindex_at",
  "last_error",
  "refresh_lock_until",
  "installed_at",
  "updated_at",
] as const satisfies readonly (keyof InstallationRow)[];

/** SQLite variables per statement stay well under D1's limit of 100. */
const CHUNK = 50;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

export class SqlStorage implements Storage {
  readonly #db: SqlDb;
  constructor(db: SqlDb) {
    this.#db = db;
  }

  getInstallation(store: string) {
    return this.#db.first<InstallationRow>("SELECT * FROM installations WHERE store = ?", [store]);
  }

  listInstallations() {
    return this.#db.all<InstallationRow>("SELECT * FROM installations ORDER BY installed_at");
  }

  async saveInstallation(row: InstallationRow) {
    await this.#db.run(
      `INSERT OR REPLACE INTO installations (${INSTALLATION_COLUMNS.join(", ")})
       VALUES (${placeholders(INSTALLATION_COLUMNS.length)})`,
      INSTALLATION_COLUMNS.map((c) => row[c]),
    );
  }

  async updateInstallation(store: string, fields: Partial<Omit<InstallationRow, "store">>) {
    const entries = Object.entries(fields).filter(([key]) =>
      (INSTALLATION_COLUMNS as readonly string[]).includes(key),
    ) as [string, SqlValue][];
    if (entries.length === 0) return;
    await this.#db.run(
      `UPDATE installations SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE store = ?`,
      [...entries.map(([, value]) => value), store],
    );
  }

  async deleteStore(store: string) {
    await this.#db.batch(
      [
        "installations",
        "marks",
        "deliveries",
        "catalog_products",
        "fixed_prices",
        "variant_products",
        "indexes",
      ].map((table) => ({ sql: `DELETE FROM ${table} WHERE store = ?`, params: [store] })),
    );
  }

  async tryLockRefresh(store: string, now: number, until: number) {
    const { changes } = await this.#db.run(
      "UPDATE installations SET refresh_lock_until = ? WHERE store = ? AND refresh_lock_until <= ?",
      [until, store, now],
    );
    return changes > 0;
  }

  async unlockRefresh(store: string) {
    await this.#db.run("UPDATE installations SET refresh_lock_until = 0 WHERE store = ?", [store]);
  }

  async saveOAuthState(state: OAuthState) {
    await this.#db.run(
      "INSERT INTO oauth_states (state, api_url, code_verifier, created_at) VALUES (?, ?, ?, ?)",
      [state.state, state.api_url, state.code_verifier, state.created_at],
    );
  }

  async takeOAuthState(state: string) {
    const rows = await this.#db.all<OAuthState>(
      "DELETE FROM oauth_states WHERE state = ? RETURNING state, api_url, code_verifier, created_at",
      [state],
    );
    return rows[0];
  }

  async recordDelivery(store: string, delivery: string, now: number) {
    const { changes } = await this.#db.run(
      "INSERT OR IGNORE INTO deliveries (store, delivery, received_at) VALUES (?, ?, ?)",
      [store, delivery, now],
    );
    return changes > 0;
  }

  async hasDelivery(store: string, delivery: string) {
    const row = await this.#db.first<{ n: number }>(
      "SELECT 1 AS n FROM deliveries WHERE store = ? AND delivery = ?",
      [store, delivery],
    );
    return row !== undefined;
  }

  async prune(before: number) {
    await this.#db.batch([
      { sql: "DELETE FROM deliveries WHERE received_at < ?", params: [before] },
      { sql: "DELETE FROM oauth_states WHERE created_at < ?", params: [before] },
    ]);
  }

  async mark(store: string, targets: readonly { target: string; priority: number }[], now: number) {
    const statements: SqlStatement[] = [];
    for (const group of chunks(targets, 20)) {
      statements.push({
        sql: `INSERT INTO marks (store, target, priority, generation, marked_at, leased_until)
              VALUES ${group.map(() => "(?, ?, ?, 1, ?, 0)").join(", ")}
              ON CONFLICT (store, target) DO UPDATE SET generation = generation + 1`,
        params: group.flatMap((t) => [store, t.target, t.priority, now]),
      });
    }
    if (statements.length > 0) await this.#db.batch(statements);
  }

  lease(
    store: string,
    [from, to]: readonly [number, number],
    limit: number,
    now: number,
    leaseMs: number,
  ) {
    return this.#db.all<Mark>(
      `UPDATE marks SET leased_until = ?
       WHERE store = ? AND target IN (
         SELECT target FROM marks
         WHERE store = ? AND leased_until <= ? AND priority BETWEEN ? AND ?
         ORDER BY priority, marked_at, target LIMIT ?)
       RETURNING target, generation, priority`,
      [now + leaseMs, store, store, now, from, to, limit],
    );
  }

  async finish(store: string, mark: Mark) {
    const { changes } = await this.#db.run(
      "DELETE FROM marks WHERE store = ? AND target = ? AND generation = ?",
      [store, mark.target, mark.generation],
    );
    if (changes === 0)
      await this.#db.run("UPDATE marks SET leased_until = 0 WHERE store = ? AND target = ?", [
        store,
        mark.target,
      ]);
  }

  async countMarks(store: string, range: readonly [number, number] = [0, 1_000]) {
    const row = await this.#db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM marks WHERE store = ? AND priority BETWEEN ? AND ?",
      [store, range[0], range[1]],
    );
    return row?.n ?? 0;
  }

  async storesWithDueMarks(now: number) {
    const rows = await this.#db.all<{ store: string }>(
      "SELECT DISTINCT store FROM marks WHERE leased_until <= ?",
      [now],
    );
    return rows.map((row) => row.store);
  }

  async replaceCatalogProducts(store: string, catalog: string, products: readonly string[]) {
    await this.#db.batch([
      {
        sql: "DELETE FROM catalog_products WHERE store = ? AND catalog = ?",
        params: [store, catalog],
      },
      ...chunks(products, 30).map((group) => ({
        sql: `INSERT OR IGNORE INTO catalog_products (store, catalog, product) VALUES ${group
          .map(() => "(?, ?, ?)")
          .join(", ")}`,
        params: group.flatMap((product) => [store, catalog, product]),
      })),
    ]);
  }

  async catalogsWith(store: string, product: string) {
    const rows = await this.#db.all<{ catalog: string }>(
      "SELECT catalog FROM catalog_products WHERE store = ? AND product = ?",
      [store, product],
    );
    return rows.map((row) => row.catalog);
  }

  async replaceFixedPrices(store: string, priceList: string, prices: readonly FixedPrice[]) {
    await this.#db.batch([
      {
        sql: "DELETE FROM fixed_prices WHERE store = ? AND price_list = ?",
        params: [store, priceList],
      },
      ...chunks(prices, 15).map((group) => ({
        sql: `INSERT OR REPLACE INTO fixed_prices (store, price_list, variant, amount, currency)
              VALUES ${group.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
        params: group.flatMap((p) => [store, priceList, p.variant, p.amount, p.currency]),
      })),
    ]);
  }

  async fixedPrices(store: string, priceList: string, variants: readonly string[]) {
    const out: FixedPrice[] = [];
    for (const group of chunks(variants)) {
      out.push(
        ...(await this.#db.all<FixedPrice>(
          `SELECT variant, amount, currency FROM fixed_prices
           WHERE store = ? AND price_list = ? AND variant IN (${placeholders(group.length)})`,
          [store, priceList, ...group],
        )),
      );
    }
    return out;
  }

  async setVariants(store: string, product: string, variants: readonly string[]) {
    await this.#db.batch([
      {
        sql: "DELETE FROM variant_products WHERE store = ? AND product = ?",
        params: [store, product],
      },
      ...chunks(variants, 30).map((group) => ({
        sql: `INSERT OR REPLACE INTO variant_products (store, variant, product) VALUES ${group
          .map(() => "(?, ?, ?)")
          .join(", ")}`,
        params: group.flatMap((variant) => [store, variant, product]),
      })),
    ]);
  }

  async productsOfVariants(store: string, variants: readonly string[]) {
    const out = new Set<string>();
    for (const group of chunks(variants)) {
      const rows = await this.#db.all<{ product: string }>(
        `SELECT DISTINCT product FROM variant_products
         WHERE store = ? AND variant IN (${placeholders(group.length)})`,
        [store, ...group],
      );
      for (const row of rows) out.add(row.product);
    }
    return [...out];
  }

  indexes(store: string) {
    return this.#db.all<IndexRow>(
      "SELECT market, uid, settings_hash FROM indexes WHERE store = ? ORDER BY market",
      [store],
    );
  }

  async saveIndex(store: string, row: IndexRow) {
    await this.#db.run(
      "INSERT OR REPLACE INTO indexes (store, market, uid, settings_hash) VALUES (?, ?, ?, ?)",
      [store, row.market, row.uid, row.settings_hash],
    );
  }

  async clearIndexes(store: string) {
    await this.#db.run("DELETE FROM indexes WHERE store = ?", [store]);
  }
}
