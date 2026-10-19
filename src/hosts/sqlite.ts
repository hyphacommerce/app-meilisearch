// `SqlDb` over Node's built-in SQLite (`node:sqlite`): the Node host's storage, and the
// tests'.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { SqlDb, SqlStatement, SqlValue } from "../core/sql.ts";

const args = (params: SqlValue[] = []): SQLInputValue[] => params;

export function sqliteDb(path: string): SqlDb & { close(): void } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return {
    // Rows come with a null prototype: copied into plain objects, as D1 answers.
    all: async <T>(sql: string, params?: SqlValue[]) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- rows of the caller's query
      db
        .prepare(sql)
        .all(...args(params))
        .map((row) => ({ ...row })) as T[],
    first: async <T>(sql: string, params?: SqlValue[]) => {
      const row = db.prepare(sql).get(...args(params));
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a row of the caller's query
      return row ? ({ ...row } as T) : undefined;
    },
    run: async (sql: string, params?: SqlValue[]) => {
      const result = db.prepare(sql).run(...args(params));
      return { changes: Number(result.changes) };
    },
    batch: async (statements: SqlStatement[]) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params } of statements) db.prepare(sql).run(...args(params));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}
