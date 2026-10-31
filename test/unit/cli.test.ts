import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTeamCli } from "../../src/cli/team";
import { openDatabase } from "../../src/state/db";
import { RunRepository } from "../../src/state/runs";
import { Tracer } from "../../src/state/trace";
import { StackService } from "../../src/stack/service";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-cli-"));
  directories.push(directory);
  return directory;
}

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  json(): any;
}

async function cli(
  cwd: string,
  argv: readonly string[],
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await runTeamCli(argv, {
    cwd,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return {
    code,
    stdout,
    stderr,
    json: () => JSON.parse(stdout || stderr),
  };
}

describe("team CLI", () => {
  test("db migrate creates the database, migrates it, and is idempotent", async () => {
    const projectDir = tempDir();
    const rootDir = path.join(projectDir, ".team");

    const first = await cli(projectDir, ["db", "migrate"]);
    expect(first.code).toBe(0);
    expect(first.json()).toMatchObject({
      ok: true,
      database: path.join(rootDir, "team.db"),
      driver: "bun:sqlite",
      from_version: 0,
      to_version: 1,
      applied: [1],
    });
    expect(existsSync(path.join(rootDir, "team.db"))).toBe(true);

    const second = await cli(projectDir, ["db", "migrate", "--root", rootDir]);
    expect(second.code).toBe(0);
    expect(second.json()).toMatchObject({ from_version: 1, to_version: 1, applied: [] });
  });

  test("stack shows detection provenance and stored run profiles", async () => {
    const projectDir = tempDir();
    const rootDir = path.join(projectDir, ".team");
    writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify({ scripts: { test: "bun test" } }),
      "utf8",
    );
    writeFileSync(path.join(projectDir, "bun.lock"), "", "utf8");

    const detected = await cli(projectDir, ["stack", "--root", rootDir]);
    expect(detected.code).toBe(0);
    expect(detected.json()).toMatchObject({
      ok: true,
      run: null,
      layer: "detected",
      sources: ["detected"],
      provenance: [{ layer: "detected", origin: "auto-detection" }],
      globs_defaulted: false,
    });
    expect(detected.json().profile.components[0].commands.test).toBe("bun run test");

    const { db } = await openDatabase(path.join(rootDir, "team.db"));
    try {
      const runs = new RunRepository(db);
      const run = runs.createRun({
        id: "run-cli",
        title: "CLI run",
        sessionId: "session-1",
        projectDir,
        phase: "brainstorm",
      });
      const service = new StackService({ rootDir, projectDir, config: { detect: true }, runs });
      service.persist(run, service.resolveForRun(run, false).profile);
    } finally {
      db.close();
    }

    const stored = await cli(projectDir, ["stack", "run-cli", "--root", rootDir]);
    expect(stored.code).toBe(0);
    expect(stored.json()).toMatchObject({
      ok: true,
      run: "run-cli",
      phase: "brainstorm",
      layer: "run",
      sources: ["researcher"],
      provenance: [{ layer: "researcher", origin: path.join(rootDir, "runs", "run-cli", "stack.json") }],
    });

    const missing = await cli(projectDir, ["stack", "missing", "--root", rootDir]);
    expect(missing.code).toBe(1);
    expect(missing.json()).toMatchObject({ ok: false, code: "cli_error" });
    expect(missing.stderr).toContain("not found");
  });

  test("models reads the live snapshot and a run's stored routing", async () => {
    const projectDir = tempDir();
    const rootDir = path.join(projectDir, ".team");
    await cli(projectDir, ["db", "migrate"]);

    const empty = await cli(projectDir, ["models", "--root", rootDir]);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("No model snapshot");

    const { db } = await openDatabase(path.join(rootDir, "team.db"));
    try {
      new Tracer(db).event("models.snapshot", {
        roles: { developer: { role: "developer", model: "provider/model", params: {}, source: "role" } },
        events: [{ type: "model.diversity_warning", reason: "same model" }],
      });
      const runs = new RunRepository(db);
      const run = runs.createRun({
        id: "run-models",
        title: "Models",
        sessionId: "session-1",
        projectDir,
        phase: "brainstorm",
      });
      runs.snapshotModels(run.id, [
        { role: "developer", model: "provider/model", params: { maxSteps: 80 }, source: "role" },
      ]);
      new Tracer(db).event(
        "model.diversity_warning",
        { role: "adversary", reason: "same model" },
        { runId: run.id },
      );
    } finally {
      db.close();
    }

    const snapshot = await cli(projectDir, ["models", "--root", rootDir]);
    expect(snapshot.code).toBe(0);
    expect(snapshot.json()).toMatchObject({
      ok: true,
      source: "snapshot",
      roles: { developer: { model: "provider/model", source: "role" } },
      events: [{ type: "model.diversity_warning" }],
    });

    const stored = await cli(projectDir, ["models", "--run", "run-models", "--root", rootDir]);
    expect(stored.code).toBe(0);
    expect(stored.json()).toMatchObject({
      ok: true,
      source: "run",
      run: "run-models",
      roles: [{ run_id: "run-models", role: "developer", model: "provider/model", source: "role" }],
      warnings: [{ kind: "model.diversity_warning" }],
    });

    const missing = await cli(projectDir, ["models", "--run", "missing", "--root", rootDir]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("not found");
  });

  test("runs lists all or open runs with age", async () => {
    const projectDir = tempDir();
    const rootDir = path.join(projectDir, ".team");
    const { db } = await openDatabase(path.join(rootDir, "team.db"));
    try {
      const runs = new RunRepository(db);
      runs.createRun({
        id: "run-open",
        title: "Open run",
        sessionId: "session-1",
        projectDir,
        phase: "brainstorm",
      });
      runs.createRun({
        id: "run-closed",
        title: "Closed run",
        sessionId: "session-2",
        projectDir,
        phase: "done",
      });
      runs.closeRun("run-closed");
    } finally {
      db.close();
    }

    const all = await cli(projectDir, ["runs", "--root", rootDir]);
    expect(all.code).toBe(0);
    expect(all.json()).toMatchObject({ ok: true, open_only: false, count: 2 });
    expect(all.json().runs.map((run: any) => run.id).sort()).toEqual(["run-closed", "run-open"]);
    expect(typeof all.json().runs[0].age_ms).toBe("number");

    const open = await cli(projectDir, ["runs", "--open", "--root", rootDir]);
    expect(open.code).toBe(0);
    expect(open.json()).toMatchObject({ ok: true, open_only: true, count: 1 });
    expect(open.json().runs[0].id).toBe("run-open");

    const extra = await cli(projectDir, ["runs", "oops", "--root", rootDir]);
    expect(extra.code).toBe(2);
  });

  test("report renders Markdown and trace exports redacted JSON and JSONL", async () => {
    const projectDir = tempDir();
    const rootDir = path.join(projectDir, ".team");
    const { db } = await openDatabase(path.join(rootDir, "team.db"));
    try {
      const runs = new RunRepository(db);
      const run = runs.createRun({
        id: "run-trace",
        title: "Trace CLI",
        sessionId: "session-1",
        projectDir,
        phase: "brainstorm",
      });
      runs.bindSession("session-1", run.id, "team-lead");
      runs.addTransition({
        runId: run.id,
        from: null,
        to: "brainstorm",
        kind: "start",
        at: "2026-01-01T10:00:00.000Z",
      });
      runs.upsertMessage({
        id: "message-1",
        sessionId: "session-1",
        runId: run.id,
        agent: "team-lead",
        model: "provider/model",
        tokensIn: 10,
        tokensOut: 5,
        cost: 0.001,
        at: "2026-01-01T10:01:00.000Z",
      });
      const tracer = new Tracer(db);
      tracer.event(
        "gate.denied",
        { phase: "brainstorm", code: "missing_artifact", message: "denied", api_key: "sk-secretvalue1234567890" },
        { runId: run.id, sessionId: "session-1", agent: "team-lead" },
      );
      tracer.toolCall({
        runId: run.id,
        sessionId: "session-1",
        agent: "developer",
        toolCallId: "call-1",
        tool: "write",
        phase: "implement",
        startedAt: "2026-01-01T10:02:00.000Z",
        durationMs: 12,
        ok: true,
        outputBytes: 20,
        input: { path: "src/a.ts", password: "hunter2" },
        outputPreview: "Authorization: Bearer abcdef",
      });
    } finally {
      db.close();
    }

    const report = await cli(projectDir, ["report", "run-trace", "--root", rootDir]);
    expect(report.code).toBe(0);
    expect(report.stdout).toContain("# Delivery run run-trace: Trace CLI");
    expect(report.stdout).toContain("## Tool calls");
    expect(report.stdout).toContain("1 messages, 10 input tokens, 5 output tokens");

    const trace = await cli(projectDir, ["trace", "run-trace", "--root", rootDir]);
    expect(trace.code).toBe(0);
    expect(trace.json()).toMatchObject({ ok: true, run: "run-trace" });
    expect(trace.json().events).toHaveLength(1);
    expect(trace.json().events[0].data.api_key).toBe("[REDACTED]");
    expect(trace.json().tool_calls[0]).toMatchObject({
      tool: "write",
      agent: "developer",
      ok: true,
      duration_ms: 12,
    });
    expect(trace.json().tool_calls[0].input).toMatchObject({
      path: "src/a.ts",
      password: "[REDACTED]",
    });
    expect(trace.json().tool_calls[0].output_preview).toContain("[REDACTED]");

    const jsonl = await cli(projectDir, ["trace", "run-trace", "--jsonl", "--root", rootDir]);
    expect(jsonl.code).toBe(0);
    const records = jsonl.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record: any) => record.type).sort()).toEqual(["event", "tool_call"]);
    expect(records[0].at <= records[1].at).toBe(true);
    expect(jsonl.stdout).not.toContain("hunter2");
    expect(jsonl.stdout).not.toContain("abcdef");
    expect(jsonl.stdout).not.toContain("sk-secretvalue");

    expect((await cli(projectDir, ["report", "--root", rootDir])).code).toBe(2);
    expect((await cli(projectDir, ["trace", "one", "two", "--root", rootDir])).code).toBe(2);
  });

  test("prints usage for help and rejects unknown commands and options", async () => {
    const projectDir = tempDir();
    const help = await cli(projectDir, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("team db migrate");

    const unknown = await cli(projectDir, ["nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.json()).toMatchObject({ ok: false, code: "usage" });

    const option = await cli(projectDir, ["db", "migrate", "--wat"]);
    expect(option.code).toBe(2);
    expect(option.json().error).toContain("Unknown option");

    const stackArgs = await cli(projectDir, ["stack", "one", "two"]);
    expect(stackArgs.code).toBe(2);
    expect(stackArgs.json().error).toContain("at most one run id");
  });
});
