// The SQL the app's storage runs on, as a port: D1 on Workers, `node:sqlite` on Node,
// both SQLite. Only what `SqlStorage` needs: reads, a write that says how many rows it
// changed, and an atomic batch.

export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface SqlDb {
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  /** One statement; `changes` is how many rows it inserted, updated or deleted. */
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  /** Every statement or none (a transaction). */
  batch(statements: SqlStatement[]): Promise<void>;
}

/** A migration: statements applied once, in order. Append only: never edit one. */
export interface Migration {
  name: string;
  statements: string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: "0001_init",
    statements: [
      // One row per store that installed the app (design note 0029, §4.1). Tokens, the
      // app secret and the Meilisearch key are sealed (`crypto.ts`).
      `CREATE TABLE installations (
        store TEXT PRIMARY KEY,
        api_url TEXT NOT NULL,
        scopes TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        app_secret TEXT NOT NULL,
        admin_origins TEXT NOT NULL DEFAULT '[]',
        meili_url TEXT,
        meili_key TEXT,
        index_prefix TEXT NOT NULL DEFAULT 'hypha',
        caches_ready INTEGER NOT NULL DEFAULT 0,
        last_reindex_at INTEGER,
        last_error TEXT,
        refresh_lock_until INTEGER NOT NULL DEFAULT 0,
        installed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      // An authorization in flight: the PKCE verifier until the redirect comes back.
      `CREATE TABLE oauth_states (
        state TEXT PRIMARY KEY,
        api_url TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      // Webhook deliveries already handled (`Hypha-Delivery-Id`, stable across retries).
      `CREATE TABLE deliveries (
        store TEXT NOT NULL,
        delivery TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (store, delivery)
      )`,
      // What to rebuild, coalesced as Hypha's own search queue is (design note 0019, §5):
      // marking a marked target bumps its generation; finishing removes it only at the
      // generation leased.
      `CREATE TABLE marks (
        store TEXT NOT NULL,
        target TEXT NOT NULL,
        priority INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        marked_at INTEGER NOT NULL,
        leased_until INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (store, target)
      )`,
      `CREATE INDEX marks_due ON marks (store, leased_until, priority, marked_at)`,
      // Copies of what the admin API only lists whole (a catalog's products, a price
      // list's fixed prices), so one product's rebuild doesn't page through them.
      `CREATE TABLE catalog_products (
        store TEXT NOT NULL,
        catalog TEXT NOT NULL,
        product TEXT NOT NULL,
        PRIMARY KEY (store, catalog, product)
      )`,
      `CREATE INDEX catalog_products_product ON catalog_products (store, product)`,
      `CREATE TABLE fixed_prices (
        store TEXT NOT NULL,
        price_list TEXT NOT NULL,
        variant TEXT NOT NULL,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        PRIMARY KEY (store, price_list, variant)
      )`,
      // Which product a variant belongs to, for stock and price events that name variants.
      `CREATE TABLE variant_products (
        store TEXT NOT NULL,
        variant TEXT NOT NULL,
        product TEXT NOT NULL,
        PRIMARY KEY (store, variant)
      )`,
      `CREATE INDEX variant_products_product ON variant_products (store, product)`,
      // The Meilisearch indexes made for a store, and the settings they were given.
      `CREATE TABLE indexes (
        store TEXT NOT NULL,
        market TEXT NOT NULL,
        uid TEXT NOT NULL,
        settings_hash TEXT NOT NULL,
        PRIMARY KEY (store, market)
      )`,
    ],
  },
];

/** Applies the migrations `db` hasn't had yet, each in one batch with its record. */
export async function migrate(db: SqlDb, migrations = MIGRATIONS): Promise<string[]> {
  await db.run(
    "CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const done = new Set(
    (await db.all<{ name: string }>("SELECT name FROM app_migrations")).map((row) => row.name),
  );
  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    try {
      await db.batch([
        ...migration.statements.map((sql) => ({ sql })),
        {
          sql: "INSERT INTO app_migrations (name, applied_at) VALUES (?, ?)",
          params: [migration.name, Date.now()],
        },
      ]);
    } catch (error) {
      // Another isolate or process may have applied it meanwhile: that's fine.
      const now = await db.first<{ name: string }>(
        "SELECT name FROM app_migrations WHERE name = ?",
        [migration.name],
      );
      if (!now) throw error;
      continue;
    }
    applied.push(migration.name);
  }
  return applied;
}
