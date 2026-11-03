import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type TeamDatabase } from "../../src/state/db";
import { LessonsRepository } from "../../src/state/lessons";
import { MIGRATIONS, type Migration } from "../../src/state/schema";
import { RunRepository } from "../../src/state/runs";
import { Tracer } from "../../src/state/trace";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDb(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-db-"));
  directories.push(directory);
  return path.join(directory, "team.db");
}

function insertRun(db: TeamDatabase, id = "run-1"): void {
  db.run(
    `INSERT INTO runs (id, title, description, status, phase, lead_session_id, project_dir, stack_json, created_at, closed_at)
     VALUES (?, 'title', NULL, 'open', 'brainstorm', 'session-1', '/project', NULL, '2026-01-01T00:00:00.000Z', NULL)`,
    [id],
  );
}

describe("database adapter and migrations", () => {
  test("fresh install applies migrations 1, 2, and 3 and configures WAL, timeout, and foreign keys", async () => {
    const dbPath = tempDb();
    const { db, migration } = await openDatabase(dbPath);
    try {
      expect(db.driver).toBe("bun:sqlite");
      expect(migration).toEqual({ fromVersion: 0, toVersion: 3, applied: [1, 2, 3] });
      expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
      expect(db.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout).toBe(5000);
      expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);

      const tables = new Set(
        db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name),
      );
      for (const expected of [
        "schema_migrations",
        "runs",
        "run_models",
        "phase_transitions",
        "loops",
        "sessions",
        "tool_calls",
        "events",
        "messages",
        "notes",
        "lessons",
        "lessons_fts",
        "prompt_versions",
        "eval_runs",
      ]) {
        expect(tables.has(expected)).toBe(true);
      }
      expect(
        db.all<{ version: number; name: string }>("SELECT version, name FROM schema_migrations ORDER BY version"),
      ).toEqual([
        { version: 1, name: "initial" },
        { version: 2, name: "learning indexes" },
        { version: 3, name: "loops role scope" },
      ]);
    } finally {
      db.close();
    }
  });

  test("reopening a migrated database is idempotent", async () => {
    const dbPath = tempDb();
    (await openDatabase(dbPath)).db.close();
    const { db, migration } = await openDatabase(dbPath);
    try {
      expect(migration).toEqual({ fromVersion: 3, toVersion: 3, applied: [] });
    } finally {
      db.close();
    }
  });

  test("upgrades a version-1 database with the M5 learning indexes and M8 loops", async () => {
    const dbPath = tempDb();
    const versionOne = await openDatabase(dbPath, { migrations: [MIGRATIONS[0]] });
    versionOne.db.close();

    const upgraded = await openDatabase(dbPath);
    try {
      expect(upgraded.migration).toEqual({ fromVersion: 1, toVersion: 3, applied: [2, 3] });
      const indexes = new Set(
        upgraded.db
          .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
          .map((row) => row.name),
      );
      expect(indexes.has("idx_lessons_status_role_stack")).toBe(true);
      expect(indexes.has("idx_lessons_source_run")).toBe(true);
      expect(indexes.has("idx_prompt_versions_role_status")).toBe(true);
      expect(upgraded.db.all<{ name: string }>("PRAGMA table_info(loops)").map((row) => row.name))
        .toEqual(["run_id", "phase", "role", "count"]);
    } finally {
      upgraded.db.close();
    }
  });

  test("applies upgrade migrations in version order and skips already applied versions", async () => {
    const dbPath = tempDb();
    (await openDatabase(dbPath)).db.close();

    const migration4: Migration = {
      version: 4,
      name: "add-test-table",
      statements: ["CREATE TABLE upgrade_probe (id INTEGER PRIMARY KEY, value TEXT)"],
    };
    const migration5: Migration = {
      version: 5,
      name: "add-second-table",
      statements: ["CREATE TABLE upgrade_probe_2 (id INTEGER PRIMARY KEY)"],
    };

    const upgraded = await openDatabase(dbPath, {
      migrations: [...MIGRATIONS, migration4, migration5],
    });
    try {
      expect(upgraded.migration).toEqual({ fromVersion: 3, toVersion: 5, applied: [4, 5] });
      expect(
        upgraded.db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version").map((row) => row.version),
      ).toEqual([1, 2, 3, 4, 5]);
    } finally {
      upgraded.db.close();
    }

    const reopened = await openDatabase(dbPath, { migrations: [...MIGRATIONS, migration4, migration5] });
    try {
      expect(reopened.migration).toEqual({ fromVersion: 5, toVersion: 5, applied: [] });
    } finally {
      reopened.db.close();
    }
  });

  test("migration 3 preserves version-1 loop counts with the phase-scoped role", async () => {
    const dbPath = tempDb();
    const versionOne = await openDatabase(dbPath, { migrations: [MIGRATIONS[0]] });
    try {
      insertRun(versionOne.db);
      versionOne.db.run("INSERT INTO loops (run_id, phase, count) VALUES (?, ?, ?)", ["run-1", "implement", 2]);
      versionOne.db.run("INSERT INTO loops (run_id, phase, count) VALUES (?, ?, ?)", ["run-1", "test", 1]);
    } finally {
      versionOne.db.close();
    }

    const upgraded = await openDatabase(dbPath);
    try {
      expect(upgraded.migration).toEqual({ fromVersion: 1, toVersion: 3, applied: [2, 3] });
      const runs = new RunRepository(upgraded.db);
      expect(runs.getLoops("run-1")).toEqual([
        { run_id: "run-1", phase: "implement", role: "", count: 2 },
        { run_id: "run-1", phase: "test", role: "", count: 1 },
      ]);
      expect(runs.countPhaseEntries("run-1", "qa")).toBe(0);
    } finally {
      upgraded.db.close();
    }
  });

  test("migration 3 adds role scope and keeps version-2 counts", async () => {
    const dbPath = tempDb();
    const versionTwo = await openDatabase(dbPath, { migrations: [MIGRATIONS[0], MIGRATIONS[1]] });
    try {
      insertRun(versionTwo.db);
      versionTwo.db.run("INSERT INTO loops (run_id, phase, count) VALUES (?, ?, ?)", ["run-1", "qa", 2]);
    } finally {
      versionTwo.db.close();
    }

    const upgraded = await openDatabase(dbPath);
    try {
      expect(upgraded.migration).toEqual({ fromVersion: 2, toVersion: 3, applied: [3] });
      const runs = new RunRepository(upgraded.db);
      expect(runs.getLoop("run-1", "qa")).toBe(2);
      expect(runs.incrementLoop("run-1", "qa", "qa")).toBe(1);
      expect(runs.incrementLoop("run-1", "qa", "qa")).toBe(2);
      expect(runs.incrementLoop("run-1", "qa", "adversary")).toBe(1);
      expect(runs.getLoop("run-1", "qa")).toBe(2);
      expect(runs.getLoop("run-1", "qa", "qa")).toBe(2);
      expect(runs.getLoop("run-1", "qa", "adversary")).toBe(1);
      expect(runs.getLoops("run-1", "qa")).toEqual([
        { run_id: "run-1", phase: "qa", role: "qa", count: 2 },
      ]);
    } finally {
      upgraded.db.close();
    }
  });

  test("migration 3 rebuilds a drifted loops table with no primary key and duplicate rows", async () => {
    const dbPath = tempDb();
    (await openDatabase(dbPath, { migrations: [MIGRATIONS[0], MIGRATIONS[1]] })).db.close();

    const raw = await openDatabase(dbPath, { migrate: false });
    try {
      insertRun(raw.db);
      raw.db.exec("DROP TABLE loops");
      raw.db.exec(
        "CREATE TABLE loops (run_id TEXT NOT NULL, phase TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)",
      );
      raw.db.run("INSERT INTO loops (run_id, phase, count) VALUES (?, ?, ?)", ["run-1", "qa", 1]);
      raw.db.run("INSERT INTO loops (run_id, phase, count) VALUES (?, ?, ?)", ["run-1", "qa", 2]);
      raw.db.run("INSERT INTO loops (run_id, phase, count) VALUES (?, ?, ?)", ["run-1", "implement", 4]);
    } finally {
      raw.db.close();
    }

    const upgraded = await openDatabase(dbPath);
    try {
      expect(upgraded.migration).toEqual({ fromVersion: 2, toVersion: 3, applied: [3] });
      const primaryKey = upgraded.db
        .all<{ name: string; pk: number }>("PRAGMA table_info(loops)")
        .filter((column) => Number(column.pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk))
        .map((column) => column.name);
      expect(primaryKey).toEqual(["run_id", "phase", "role"]);

      const runs = new RunRepository(upgraded.db);
      expect(runs.getLoop("run-1", "qa")).toBe(3);
      expect(runs.getLoop("run-1", "implement")).toBe(4);
      expect(runs.incrementLoop("run-1", "qa")).toBe(4);
      expect(runs.incrementLoop("run-1", "qa", "qa")).toBe(1);
      expect(runs.getLoops("run-1")).toEqual([
        { run_id: "run-1", phase: "implement", role: "", count: 4 },
        { run_id: "run-1", phase: "qa", role: "", count: 4 },
        { run_id: "run-1", phase: "qa", role: "qa", count: 1 },
      ]);
    } finally {
      upgraded.db.close();
    }

    const reopened = await openDatabase(dbPath);
    try {
      expect(reopened.migration).toEqual({ fromVersion: 3, toVersion: 3, applied: [] });
      const runs = new RunRepository(reopened.db);
      expect(runs.getLoop("run-1", "qa")).toBe(4);
      expect(runs.getLoop("run-1", "qa", "qa")).toBe(1);
    } finally {
      reopened.db.close();
    }
  });

  test("migration 3 folds a drifted role column into the phase scope", async () => {
    const dbPath = tempDb();
    (await openDatabase(dbPath, { migrations: [MIGRATIONS[0], MIGRATIONS[1]] })).db.close();

    const raw = await openDatabase(dbPath, { migrate: false });
    try {
      insertRun(raw.db);
      raw.db.exec("DROP TABLE loops");
      raw.db.exec(
        "CREATE TABLE loops (run_id TEXT NOT NULL, phase TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 0)",
      );
      raw.db.run("INSERT INTO loops (run_id, phase, role, count) VALUES (?, ?, ?, ?)", ["run-1", "qa", "qa", 1]);
      raw.db.run("INSERT INTO loops (run_id, phase, role, count) VALUES (?, ?, ?, ?)", ["run-1", "qa", "adversary", 2]);
      raw.db.run("INSERT INTO loops (run_id, phase, role, count) VALUES (?, ?, ?, ?)", ["run-1", "qa", "", 4]);
    } finally {
      raw.db.close();
    }

    const upgraded = await openDatabase(dbPath);
    try {
      expect(upgraded.migration).toEqual({ fromVersion: 2, toVersion: 3, applied: [3] });
      expect(new RunRepository(upgraded.db).getLoops("run-1")).toEqual([
        { run_id: "run-1", phase: "qa", role: "", count: 7 },
      ]);
    } finally {
      upgraded.db.close();
    }
  });

  test("rolls back a migration whose verify fails and does not record the version", async () => {
    const dbPath = tempDb();
    const failing: Migration = {
      version: 4,
      name: "failing verification",
      statements: ["CREATE TABLE migration_probe (id INTEGER PRIMARY KEY)"],
      verify: () => {
        throw new Error("verification failed");
      },
    };

    await expect(openDatabase(dbPath, { migrations: [...MIGRATIONS, failing] }))
      .rejects.toThrow("verification failed");

    const reopened = await openDatabase(dbPath);
    try {
      expect(reopened.migration).toEqual({ fromVersion: 3, toVersion: 3, applied: [] });
      expect(
        reopened.db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_probe'"),
      ).toBeUndefined();
    } finally {
      reopened.db.close();
    }
  });

  test("migration 3 rolls back a failed legacy copy and leaves the old table and version intact", async () => {
    const dbPath = tempDb();
    (await openDatabase(dbPath, { migrations: [MIGRATIONS[0], MIGRATIONS[1]] })).db.close();

    const raw = await openDatabase(dbPath, { migrate: false });
    try {
      insertRun(raw.db);
      raw.db.exec("DROP TABLE loops");
      raw.db.exec("CREATE TABLE loops (run_id TEXT NOT NULL, phase TEXT NOT NULL)");
      raw.db.run("INSERT INTO loops (run_id, phase) VALUES (?, ?)", ["run-1", "qa"]);
    } finally {
      raw.db.close();
    }

    await expect(openDatabase(dbPath)).rejects.toThrow();

    const reopened = await openDatabase(dbPath, { migrate: false });
    try {
      expect(
        reopened.db.all<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")
          .map((row) => Number(row.version)),
      ).toEqual([1, 2]);
      expect(reopened.db.all<{ name: string }>("PRAGMA table_info(loops)").map((row) => row.name))
        .toEqual(["run_id", "phase"]);
      expect(reopened.db.all("SELECT run_id, phase FROM loops")).toEqual([
        { run_id: "run-1", phase: "qa" },
      ]);
      expect(
        reopened.db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'loops_v3'"),
      ).toBeUndefined();
    } finally {
      reopened.db.close();
    }
  });

  test("rolls back a failed transaction and honors nested savepoints", async () => {
    const { db } = await openDatabase(tempDb());
    try {
      expect(() => db.transaction((tx) => {
        insertRun(tx, "rolled-back");
        throw new Error("boom");
      })).toThrow("boom");
      expect(db.get("SELECT id FROM runs WHERE id = 'rolled-back'")).toBeUndefined();

      db.transaction((tx) => {
        insertRun(tx, "outer");
        try {
          tx.transaction((inner) => {
            insertRun(inner, "inner");
            throw new Error("inner boom");
          });
        } catch {
          // The outer transaction survives a rolled-back savepoint.
        }
        insertRun(tx, "outer-2");
      });

      expect(db.get("SELECT id FROM runs WHERE id = 'outer'")).toBeDefined();
      expect(db.get("SELECT id FROM runs WHERE id = 'outer-2'")).toBeDefined();
      expect(db.get("SELECT id FROM runs WHERE id = 'inner'")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("enforces foreign keys through the adapter", async () => {
    const { db } = await openDatabase(tempDb());
    try {
      expect(() => db.run(
        `INSERT INTO run_models (run_id, role, model, params_json, source)
         VALUES ('missing', 'developer', NULL, '{}', 'inherit')`,
      )).toThrow();
    } finally {
      db.close();
    }
  });

  test("keeps the FTS index in sync on insert, update, and delete", async () => {
    const { db } = await openDatabase(tempDb());
    try {
      const insert = db.run(
        "INSERT INTO lessons (role, text, created_at) VALUES ('*', 'always write tests first', 'now')",
      );
      expect(searchLessons(db, "tests")).toEqual([Number(insert.lastInsertRowid)]);

      db.run("UPDATE lessons SET text = 'read the spec twice' WHERE id = ?", [insert.lastInsertRowid]);
      expect(searchLessons(db, "tests")).toEqual([]);
      expect(searchLessons(db, "spec")).toEqual([Number(insert.lastInsertRowid)]);

      db.run("DELETE FROM lessons WHERE id = ?", [insert.lastInsertRowid]);
      expect(searchLessons(db, "spec")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function searchLessons(db: TeamDatabase, term: string): number[] {
  return db.all<{ rowid: number }>(
    "SELECT rowid FROM lessons_fts WHERE lessons_fts MATCH ? ORDER BY rowid",
    [term],
  ).map((row) => Number(row.rowid));
}

describe("trace API", () => {
  test("writes events and tool calls with caller identity", async () => {
    const { db } = await openDatabase(tempDb());
    try {
      const tracer = new Tracer(db);
      tracer.event("phase.advanced", { from: "spec", to: "plan" }, {
        runId: "run-1",
        sessionId: "session-1",
        agent: "team-lead",
        toolCallId: "call-1",
        phase: "plan",
      });
      tracer.toolCall({
        runId: "run-1",
        sessionId: "session-1",
        agent: "developer",
        toolCallId: "call-2",
        tool: "edit",
        phase: "implement",
        startedAt: "2026-01-01T00:00:00.000Z",
        durationMs: 12,
        ok: true,
        outputBytes: 4,
        input: { path: "src/a.ts" },
        outputPreview: "done",
      });

      const event = db.get<{ run_id: string; kind: string; data_json: string }>(
        "SELECT run_id, kind, data_json FROM events",
      );
      expect(event?.run_id).toBe("run-1");
      expect(event?.kind).toBe("phase.advanced");
      expect(JSON.parse(event?.data_json ?? "{}")).toEqual({
        from: "spec",
        to: "plan",
        session_id: "session-1",
        agent: "team-lead",
        tool_call_id: "call-1",
        phase: "plan",
      });

      const call = db.get<Record<string, unknown>>("SELECT * FROM tool_calls");
      expect(call).toMatchObject({
        run_id: "run-1",
        session_id: "session-1",
        agent: "developer",
        tool_call_id: "call-2",
        tool: "edit",
        phase: "implement",
        duration_ms: 12,
        ok: 1,
        output_bytes: 4,
      });
      expect(JSON.parse(String(call?.input_json))).toEqual({ path: "src/a.ts" });
    } finally {
      db.close();
    }
  });

  test("never throws when the database is closed and reports errors", async () => {
    const { db } = await openDatabase(tempDb());
    db.close();
    const errors: string[] = [];
    const tracer = new Tracer(db, undefined, (error) => errors.push(error.operation));

    expect(() => tracer.event("broken", { value: 1 })).not.toThrow();
    expect(() => tracer.toolCall({ tool: "team_start" })).not.toThrow();
    expect(tracer.getErrors().map((error) => error.operation)).toEqual(["event", "toolCall"]);
    expect(errors).toEqual(["event", "toolCall"]);
  });

  test("is a no-op without a database", () => {
    const tracer = new Tracer(null);
    expect(() => tracer.event("nothing")).not.toThrow();
    expect(() => tracer.toolCall({ tool: "nothing" })).not.toThrow();
    expect(tracer.getErrors()).toEqual([]);
  });
});

describe("run repositories", () => {
  test("creates runs, transitions, loops, notes, sessions, and model snapshots", async () => {
    const { db } = await openDatabase(tempDb());
    try {
      const runs = new RunRepository(db, () => "2026-01-01T00:00:00.000Z");
      const run = runs.createRun({
        id: "run-1",
        title: "Add pagination",
        description: "Keep it stable",
        sessionId: "session-1",
        projectDir: "/project",
        phase: "brainstorm",
      });
      expect(run).toMatchObject({
        id: "run-1",
        title: "Add pagination",
        description: "Keep it stable",
        status: "open",
        phase: "brainstorm",
        lead_session_id: "session-1",
      });

      runs.addTransition({ runId: "run-1", from: null, to: "brainstorm", kind: "start" });
      runs.updatePhase("run-1", "spec");
      runs.addTransition({ runId: "run-1", from: "brainstorm", to: "spec", kind: "advance" });
      expect(runs.getPhaseStartedAt("run-1")).toBe("2026-01-01T00:00:00.000Z");
      expect(runs.getTransitions("run-1")).toHaveLength(2);
      expect(runs.countPhaseEntries("run-1", "spec")).toBe(1);
      expect(runs.countPhaseEntries("run-1", "qa")).toBe(0);

      expect(runs.getLoop("run-1", "implement")).toBe(0);
      expect(runs.incrementLoop("run-1", "implement")).toBe(1);
      expect(runs.incrementLoop("run-1", "implement")).toBe(2);
      expect(runs.getLoops("run-1")).toEqual([
        { run_id: "run-1", phase: "implement", role: "", count: 2 },
      ]);

      runs.addNote({
        runId: "run-1",
        kind: "decision",
        text: "human_approval granted",
        agent: "team-lead",
        sessionId: "session-1",
      });
      expect(runs.listNotes("run-1")).toEqual([
        expect.objectContaining({ kind: "decision", text: "human_approval granted", agent: "team-lead" }),
      ]);

      runs.upsertSession({ id: "session-1", agent: "team-lead", runId: "run-1" });
      runs.bindSession("session-1", "run-1", "team-lead");
      expect(runs.findRunBySession("session-1")?.id).toBe("run-1");
      expect(runs.getSession("session-1")?.run_id).toBe("run-1");

      runs.upsertSession({ id: "child", parentId: "session-1", agent: "developer" });
      expect(runs.getSession("child")?.parent_id).toBe("session-1");
      expect(runs.findRunBySession("child")).toBeUndefined();

      runs.snapshotModels("run-1", [
        { role: "developer", model: "provider/model", params: { maxSteps: 80 }, source: "role" },
        { role: "tester", model: null, params: {}, source: "inherit" },
      ]);
      expect(runs.listRunModels("run-1")).toEqual([
        { run_id: "run-1", role: "developer", model: "provider/model", params: { maxSteps: 80 }, source: "role" },
        { run_id: "run-1", role: "tester", model: null, params: {}, source: "inherit" },
      ]);

      db.run(
        "INSERT INTO lessons (role, text, status, created_at) VALUES ('*', 'proposed', 'proposed', 'now')",
      );
      expect(new LessonsRepository(db).countOpen()).toBe(1);
      expect(runs.countOpenLessons()).toBe(1);

      runs.closeRun("run-1");
      expect(runs.getRun("run-1")?.status).toBe("closed");
      expect(runs.listOpenRuns()).toEqual([]);

      runs.addNote({ runId: "run-1", kind: "finding", text: "latest" });
      expect(runs.latestEvent("missing")).toBeUndefined();
      db.run(
        "INSERT INTO events (run_id, at, kind, data_json) VALUES (?, 'now', 'gate.scope_default', '{}')",
        ["run-1"],
      );
      expect(runs.hasEvent("run-1", "gate.scope_default")).toBe(true);
      expect(runs.hasEvent("run-1", "gate.scope_skipped")).toBe(false);
      expect(runs.hasEvent("other-run", "gate.scope_default")).toBe(false);
    } finally {
      db.close();
    }
  });
});
