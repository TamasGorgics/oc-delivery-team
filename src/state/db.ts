import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrate, type Migration, type MigrationResult } from "./schema";

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface TeamDatabase {
  readonly path: string;
  readonly driver: "bun:sqlite" | "node:sqlite";
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): RunResult;
  get<T>(sql: string, params?: readonly SqlValue[]): T | undefined;
  all<T>(sql: string, params?: readonly SqlValue[]): T[];
  transaction<T>(fn: (db: TeamDatabase) => T): T;
  close(): void;
}

export interface OpenDatabaseOptions {
  readonly driver?: "bun:sqlite" | "node:sqlite";
  readonly migrations?: readonly Migration[];
  readonly migrate?: boolean;
}

export interface OpenDatabaseResult {
  readonly db: TeamDatabase;
  readonly migration: MigrationResult;
}

interface BunStatement {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface BunDatabase {
  exec(sql: string): void;
  query(sql: string): BunStatement;
  close(): void;
}

interface NodeStatement {
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface NodeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
}

export async function openDatabase(
  dbPath: string,
  options: OpenDatabaseOptions = {},
): Promise<OpenDatabaseResult> {
  if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });

  const driver = options.driver ?? (typeof Bun === "undefined" ? "node:sqlite" : "bun:sqlite");
  const db = driver === "bun:sqlite" ? await openBunDatabase(dbPath) : await openNodeDatabase(dbPath);

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");

  const migration = options.migrate === false
    ? { fromVersion: 0, toVersion: 0, applied: [] }
    : migrate(db, options.migrations);
  return { db, migration };
}

async function openBunDatabase(dbPath: string): Promise<TeamDatabase> {
  const module = await import("bun:sqlite") as unknown as {
    Database: new (filename: string, options?: { create?: boolean; readwrite?: boolean; strict?: boolean }) => BunDatabase;
  };
  const database = new module.Database(dbPath, { create: true });
  return wrapDatabase(database, dbPath, "bun:sqlite");
}

async function openNodeDatabase(dbPath: string): Promise<TeamDatabase> {
  const module = await import("node:sqlite") as unknown as {
    DatabaseSync: new (filename: string) => NodeDatabase;
  };
  const database = new module.DatabaseSync(dbPath);
  return wrapDatabase(database, dbPath, "node:sqlite");
}

function wrapDatabase(
  database: BunDatabase | NodeDatabase,
  dbPath: string,
  driver: TeamDatabase["driver"],
): TeamDatabase {
  let transactionDepth = 0;
  let closed = false;

  const statement = (sql: string): BunStatement | NodeStatement => {
    if (driver === "bun:sqlite") return (database as BunDatabase).query(sql);
    return (database as NodeDatabase).prepare(sql);
  };

  const binding = (params: readonly SqlValue[] = []): SqlValue[] => params.map((value) => {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "bigint") {
      if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("SQLite binding is outside the safe integer range.");
      }
      return Number(value);
    }
    return value;
  });

  const db: TeamDatabase = {
    path: dbPath,
    driver,
    exec(sql) {
      database.exec(sql);
    },
    run(sql, params = []) {
      const result = statement(sql).run(...binding(params));
      return {
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid,
      };
    },
    get<T>(sql: string, params: readonly SqlValue[] = []) {
      const row = statement(sql).get(...binding(params));
      return row === null ? undefined : row as T | undefined;
    },
    all<T>(sql: string, params: readonly SqlValue[] = []) {
      return statement(sql).all(...binding(params)) as T[];
    },
    transaction<T>(fn: (inner: TeamDatabase) => T): T {
      const depth = transactionDepth;
      const savepoint = `delivery_team_sp_${depth}`;
      if (depth === 0) {
        database.exec("BEGIN IMMEDIATE");
      } else {
        database.exec(`SAVEPOINT ${savepoint}`);
      }
      transactionDepth += 1;
      try {
        const result = fn(db);
        transactionDepth -= 1;
        if (depth === 0) {
          database.exec("COMMIT");
        } else {
          database.exec(`RELEASE ${savepoint}`);
        }
        return result;
      } catch (error) {
        transactionDepth -= 1;
        try {
          if (depth === 0) {
            database.exec("ROLLBACK");
          } else {
            database.exec(`ROLLBACK TO ${savepoint}`);
            database.exec(`RELEASE ${savepoint}`);
          }
        } catch {
          // Preserve the original error; a failed rollback is already fatal for this transaction.
        }
        throw error;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  };

  return db;
}
