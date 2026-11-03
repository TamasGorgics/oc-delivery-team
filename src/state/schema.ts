import type { TeamDatabase } from "./db";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
  /** Optional schema assertion executed inside the migration transaction. */
  readonly verify?: (db: TeamDatabase) => void;
}

export const MIGRATION_1_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','blocked','closed','aborted')),
    phase TEXT NOT NULL, lead_session_id TEXT,
    project_dir TEXT NOT NULL, stack_json TEXT, created_at TEXT NOT NULL, closed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS run_models (
    run_id TEXT NOT NULL REFERENCES runs(id), role TEXT NOT NULL,
    model TEXT, params_json TEXT,
    source TEXT NOT NULL CHECK (source IN ('role','tier','default','inherit','fallback')),
    PRIMARY KEY (run_id, role)
  )`,
  `CREATE TABLE IF NOT EXISTS phase_transitions (
    id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
    from_phase TEXT, to_phase TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('advance','rewind','start')),
    reason TEXT, at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS loops (
    run_id TEXT NOT NULL REFERENCES runs(id), phase TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, phase)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, parent_id TEXT, run_id TEXT REFERENCES runs(id),
    agent TEXT, started_at TEXT, ended_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY, run_id TEXT, session_id TEXT, agent TEXT,
    tool_call_id TEXT, tool TEXT NOT NULL, phase TEXT,
    started_at TEXT, duration_ms INTEGER, ok INTEGER,
    output_bytes INTEGER, input_json TEXT, output_preview TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id, started_at)`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY, run_id TEXT, at TEXT NOT NULL,
    kind TEXT NOT NULL, data_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT, run_id TEXT, agent TEXT, model TEXT,
    tokens_in INTEGER, tokens_out INTEGER, cost REAL, at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
    kind TEXT NOT NULL, text TEXT NOT NULL, agent TEXT, session_id TEXT, at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY, role TEXT NOT NULL,
    text TEXT NOT NULL, evidence TEXT, source_run TEXT,
    stack_tag TEXT NOT NULL DEFAULT '*',
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','retired','rejected')),
    hit_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, decided_at TEXT
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(text, content='lessons', content_rowid='id')`,
  `CREATE TRIGGER IF NOT EXISTS lessons_ai AFTER INSERT ON lessons BEGIN
    INSERT INTO lessons_fts(rowid, text) VALUES (new.id, new.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS lessons_ad AFTER DELETE ON lessons BEGIN
    INSERT INTO lessons_fts(lessons_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS lessons_au AFTER UPDATE ON lessons BEGIN
    INSERT INTO lessons_fts(lessons_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO lessons_fts(rowid, text) VALUES (new.id, new.text);
  END`,
  `CREATE TABLE IF NOT EXISTS prompt_versions (
    id INTEGER PRIMARY KEY, role TEXT NOT NULL, sha TEXT NOT NULL, path TEXT,
    status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','superseded')),
    source_run TEXT, created_at TEXT NOT NULL, decided_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS eval_runs (
    id INTEGER PRIMARY KEY, task TEXT NOT NULL, prompt_set_sha TEXT, model_set_sha TEXT, stack TEXT, started_at TEXT NOT NULL,
    score REAL, details_json TEXT
  )`,
];

export const MIGRATION_2_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_lessons_status_role_stack ON lessons(status, role, stack_tag)`,
  `CREATE INDEX IF NOT EXISTS idx_lessons_source_run ON lessons(source_run)`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_versions_role_status ON prompt_versions(role, status)`,
];

export const MIGRATION_3_STATEMENTS: readonly string[] = [
  `DROP TABLE IF EXISTS loops_v3`,
  `CREATE TABLE loops_v3 (
    run_id TEXT NOT NULL REFERENCES runs(id),
    phase TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, phase, role)
  )`,
  `INSERT INTO loops_v3 (run_id, phase, role, count)
    SELECT run_id, phase, '', COALESCE(SUM(count), 0)
    FROM loops
    GROUP BY run_id, phase`,
  `DROP TABLE loops`,
  `ALTER TABLE loops_v3 RENAME TO loops`,
];

export const MIGRATION_3: Migration = {
  version: 3,
  name: "loops role scope",
  statements: MIGRATION_3_STATEMENTS,
  verify: verifyLoopsRoleScope,
};

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial", statements: MIGRATION_1_STATEMENTS },
  { version: 2, name: "learning indexes", statements: MIGRATION_2_STATEMENTS },
  MIGRATION_3,
];

function verifyLoopsRoleScope(db: TeamDatabase): void {
  const columns = db.all<{ name: string; notnull: number; pk: number }>("PRAGMA table_info(loops)");
  const byName = new Map(columns.map((column) => [column.name, column]));
  for (const required of ["run_id", "phase", "role", "count"]) {
    if (!byName.has(required)) {
      throw new Error(`Migration 3 verification failed: loops is missing the '${required}' column.`);
    }
  }

  const primaryKey = columns
    .filter((column) => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((column) => column.name);
  const expectedPrimaryKey = ["run_id", "phase", "role"];
  if (
    primaryKey.length !== expectedPrimaryKey.length
    || primaryKey.some((column, index) => column !== expectedPrimaryKey[index])
  ) {
    throw new Error(
      `Migration 3 verification failed: loops primary key is (${primaryKey.join(", ") || "none"}) instead of (run_id, phase, role).`,
    );
  }

  if (Number(byName.get("role")?.notnull) !== 1) {
    throw new Error("Migration 3 verification failed: loops.role must be NOT NULL.");
  }
}

export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly number[];
}

export function migrate(db: TeamDatabase, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const appliedRows = db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");
  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  const fromVersion = appliedRows.length > 0 ? Math.max(...appliedRows.map((row) => Number(row.version))) : 0;
  const newlyApplied: number[] = [];

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    const didApply = db.transaction((tx) => {
      // Another process may have applied this migration while this connection
      // waited for the BEGIN IMMEDIATE write lock. Re-check before mutating.
      const alreadyApplied = tx.get<{ found: number }>(
        "SELECT 1 AS found FROM schema_migrations WHERE version = ?",
        [migration.version],
      );
      if (alreadyApplied) return false;

      for (const statement of migration.statements) tx.exec(statement);
      migration.verify?.(tx);
      tx.run(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, new Date().toISOString()],
      );
      return true;
    });
    if (didApply) newlyApplied.push(migration.version);
  }

  const maxRow = db.get<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_migrations");
  const toVersion = maxRow?.version == null ? 0 : Number(maxRow.version);
  return { fromVersion, toVersion, applied: newlyApplied };
}
