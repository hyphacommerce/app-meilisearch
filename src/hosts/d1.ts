// `SqlDb` over a D1 binding: the Workers host's storage. D1's `batch` is a transaction.

import type { D1Database } from "@cloudflare/workers-types/index.ts";

import type { SqlDb, SqlStatement, SqlValue } from "../core/sql.ts";

export function d1Db(db: D1Database): SqlDb {
  const bind = (sql: string, params: SqlValue[] = []) => db.prepare(sql).bind(...params);
  return {
    all: async <T>(sql: string, params?: SqlValue[]) => (await bind(sql, params).all<T>()).results,
    first: async <T>(sql: string, params?: SqlValue[]) =>
      (await bind(sql, params).first<T>()) ?? undefined,
    run: async (sql: string, params?: SqlValue[]) => {
      const result = await bind(sql, params).run();
      return { changes: result.meta.changes };
    },
    batch: async (statements: SqlStatement[]) => {
      if (statements.length === 0) return;
      await db.batch(statements.map(({ sql, params }) => bind(sql, params)));
    },
  };
}
