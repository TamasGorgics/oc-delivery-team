import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import deliveryTeam, { getDeliveryTeamSnapshot } from "../../src/index";
import { openDatabase } from "../../src/state/db";
import { PromptRepository } from "../../src/state/prompts";
import { RunRepository } from "../../src/state/runs";
import { Tracer } from "../../src/state/trace";
import { createFakeContext, type FakeContextHarness } from "../fakes/ctx";

interface Harness {
  readonly fake: FakeContextHarness;
  readonly projectDir: string;
  readonly rootDir: string;
}

type ToolOutput = Record<string, any>;
type ToolCallContext = { sessionID?: string; agent?: string; id?: string };

const directories: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Tests may deliberately break the database; cleanup stays best-effort.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempProject(prepare?: (directory: string) => void): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-tools-"));
  directories.push(directory);
  prepare?.(directory);
  return directory;
}

async function setup(options: {
  readonly projectDir?: string;
  readonly config?: unknown;
  readonly prepare?: (directory: string) => void;
} = {}): Promise<Harness> {
  const projectDir = options.projectDir ?? tempProject(options.prepare);
  const fake = createFakeContext({
    projectDirectory: projectDir,
    ...(options.config === undefined ? {} : { options: options.config }),
  });
  const cleanup = await deliveryTeam.setup(fake.context);
  if (typeof cleanup !== "function") throw new Error("Plugin setup did not return a cleanup function.");
  cleanups.push(cleanup);
  return { fake, projectDir, rootDir: path.join(projectDir, ".team") };
}

function output(result: { output?: unknown }): ToolOutput {
  return (result.output ?? {}) as ToolOutput;
}

async function call(
  harness: Harness,
  name: string,
  input: unknown = {},
  context: ToolCallContext = {},
): Promise<ToolOutput> {
  return output(await harness.fake.invokeTool(name, input, context));
}

function writeArtifact(harness: Harness, runId: string, artifact: string, contents: string): string {
  const directory = path.join(harness.rootDir, "runs", runId);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, artifact);
  writeFileSync(file, contents, "utf8");
  return file;
}

function footer(keys: readonly string[], trailing = "\n"): string {
  return `# Artifact\n\n<!-- team-footer -->\n${keys.join("\n")}\n<!-- /team-footer -->${trailing}`;
}

async function driveToTest(harness: Harness, run: string): Promise<void> {
  writeArtifact(harness, run, "brainstorm.md", "# Brainstorm\n");
  expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "spec" });
  writeArtifact(harness, run, "spec.md", footer(["STATUS: APPROVED"]));
  await call(harness, "team_note", { run, kind: "decision", text: "human_approval: approved" });
  expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "plan" });
  writeArtifact(harness, run, "plan.md", "# Plan\n");
  expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "implement" });
  writeArtifact(harness, run, "impl-notes.md", "# Implementation\n");
  expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "test" });
}

async function driveToQa(harness: Harness, run: string): Promise<void> {
  await driveToTest(harness, run);
  writeArtifact(harness, run, "test-report.md", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: 0"]));
  expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "qa" });
}

async function runEvents(
  harness: Harness,
  runId: string,
): Promise<Array<{ kind: string; at: string; data: Record<string, any> }>> {
  const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
  try {
    return db
      .all<{ kind: string; at: string; data_json: string | null }>(
        "SELECT kind, at, data_json FROM events WHERE run_id = ? ORDER BY id",
        [runId],
      )
      .map((row) => ({ kind: row.kind, at: row.at, data: JSON.parse(row.data_json ?? "{}") }));
  } finally {
    db.close();
  }
}

async function loopCounts(harness: Harness, runId: string): Promise<Record<string, number>> {
  const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
  try {
    const result: Record<string, number> = {};
    for (const row of new RunRepository(db).getLoops(runId)) {
      result[`${row.phase}:${row.role}`] = Number(row.count);
    }
    return result;
  } finally {
    db.close();
  }
}

async function transitionTargets(harness: Harness, runId: string): Promise<string[]> {
  const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
  try {
    return new RunRepository(db).getTransitions(runId).map((transition) => transition.to_phase);
  } finally {
    db.close();
  }
}

async function readRun(harness: Harness, runId: string) {
  const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
  try {
    return new RunRepository(db).getRun(runId);
  } finally {
    db.close();
  }
}

describe("tool registration and team_start", () => {
  test("registers all M2 tools and exposes database and model snapshots", async () => {
    const harness = await setup();
    expect([...harness.fake.state.tools.keys()].sort()).toEqual([
      "team_advance",
      "team_lesson_propose",
      "team_loop",
      "team_note",
      "team_rewind",
      "team_stack",
      "team_stack_update",
      "team_start",
      "team_status",
      "team_worktree",
    ]);
    expect(harness.fake.state.toolReloadCount).toBe(1);
    for (const tool of harness.fake.state.tools.values()) {
      expect(tool.output).toMatchObject({
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      });
    }

    const snapshot = getDeliveryTeamSnapshot(harness.fake.context);
    expect(snapshot?.tools).toEqual([...harness.fake.state.tools.keys()]);
    expect(snapshot?.database).toEqual({
      path: path.join(harness.rootDir, "team.db"),
      driver: "bun:sqlite",
      status: "ready",
      schemaVersion: 3,
    });
    expect(Object.keys(snapshot?.models.roles ?? {})).toHaveLength(9);
  });

  test("team_status reports tool, message, gate, and loop counters", async () => {
    const harness = await setup({ config: { gating: { enabled: false } } });
    const started = await call(harness, "team_start", { title: "Counters" });
    const run = started.run as string;

    await harness.fake.invokeToolBefore({
      tool: "read",
      input: { path: "src/a.ts" },
      sessionID: "session-1",
      agent: "team-lead",
      id: "call-read",
    });
    await harness.fake.invokeToolAfter({
      tool: "read",
      input: { path: "src/a.ts" },
      sessionID: "session-1",
      agent: "team-lead",
      id: "call-read",
      status: "completed",
      result: { output: { ok: true }, content: [{ type: "text", text: "read" }] },
    });
    await harness.fake.invokeToolBefore({
      tool: "shell",
      input: { command: "false" },
      sessionID: "session-1",
      agent: "team-lead",
      id: "call-shell",
    });
    await harness.fake.invokeToolAfter({
      tool: "shell",
      input: { command: "false" },
      sessionID: "session-1",
      agent: "team-lead",
      id: "call-shell",
      status: "error",
      error: { message: "exit 1" },
    });

    const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
    try {
      const runs = new RunRepository(db);
      runs.upsertMessage({
        id: "message-status",
        sessionId: "session-1",
        runId: run,
        agent: "team-lead",
        model: "provider/model",
        tokensIn: 7,
        tokensOut: 3,
        cost: 0.004,
      });
      runs.incrementLoop(run, "brainstorm");
      new Tracer(db).event("gate.denied", { phase: "brainstorm" }, { runId: run });
    } finally {
      db.close();
    }

    const status = await call(harness, "team_status", { run });
    expect(status.owner).toBe("researcher");
    expect(status.next_action).toContain("Owner: researcher");
    expect(status.counters).toMatchObject({
      tool_calls: 2,
      tool_failures: 1,
      gate_denials: 1,
      gate_unresolved: 0,
      loops: 1,
      messages: 1,
      tokens_in: 7,
      tokens_out: 3,
      cost: 0.004,
    });
    expect(status.recent_tool_calls).toHaveLength(2);
    expect(status.recent_tool_calls.map((row: any) => row.tool).sort()).toEqual(["read", "shell"]);
    expect(status.text).toBeUndefined();
  });

  test("team_status makes the plan phase a spec-owned verification step", async () => {
    const harness = await setup();
    const started = await call(harness, "team_start", { title: "Plan ownership" });
    const run = started.run as string;
    const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
    try {
      new RunRepository(db).updatePhase(run, "plan");
    } finally {
      db.close();
    }

    const status = await call(harness, "team_status", { run });
    expect(status).toMatchObject({ phase: "plan", owner: "spec" });
    expect(status.next_action).toContain("never use the built-in plan agent");
    expect(status.next_action).toContain("Re-dispatch the spec subagent");
  });

  test("team_start creates the run, artifact directory, session binding, transitions, and model rows", async () => {
    const harness = await setup();
    const result = await call(harness, "team_start", {
      title: "Ship the thing",
      description: "A test goal",
    }, { sessionID: "session-a", agent: "team-lead", id: "call-start" });

    expect(result.ok).toBe(true);
    expect(result.run).toMatch(/^[0-9a-z]+-ship-the-thing$/);
    expect(result.phase).toBe("brainstorm");
    expect(result.artifact_dir).toBe(path.join(harness.rootDir, "runs", result.run));

    const snapshot = getDeliveryTeamSnapshot(harness.fake.context);
    const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
    try {
      const runs = new RunRepository(db);
      const run = runs.getRun(result.run);
      expect(run).toMatchObject({
        id: result.run,
        title: "Ship the thing",
        description: "A test goal",
        status: "open",
        phase: "brainstorm",
        lead_session_id: "session-a",
        project_dir: harness.projectDir,
      });
      expect(runs.getTransitions(result.run)).toEqual([
        expect.objectContaining({ from_phase: null, to_phase: "brainstorm", kind: "start" }),
      ]);
      expect(runs.getSession("session-a")?.run_id).toBe(result.run);

      const expectedModels = Object.values(snapshot?.models.roles ?? {})
        .map((route) => ({
          run_id: result.run,
          role: route!.role,
          model: route!.model,
          params: route!.params,
          source: route!.source,
        }))
        .sort((a, b) => a.role.localeCompare(b.role));
      expect(runs.listRunModels(result.run)).toEqual(expectedModels);

      const startEvent = db.get<{ data_json: string }>(
        "SELECT data_json FROM events WHERE run_id = ? AND kind = 'run.start'",
        [result.run],
      );
      expect(JSON.parse(startEvent?.data_json ?? "{}")).toMatchObject({
        title: "Ship the thing",
        session_id: "session-a",
        agent: "team-lead",
        tool_call_id: "call-start",
        phase: "brainstorm",
      });
    } finally {
      db.close();
    }
  });

  test("expected failures are returned as ok:false instead of throwing", async () => {
    const harness = await setup();
    expect(await call(harness, "team_start", { title: "" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await call(harness, "team_start", { title: "ok", extra: true }))
      .toMatchObject({ ok: false, code: "invalid_input" });
    expect(await call(harness, "team_status")).toMatchObject({ ok: false, code: "run_not_found" });
    expect(await call(harness, "team_loop", { reason: "retry" }))
      .toMatchObject({ ok: false, code: "run_not_found" });

    const started = await call(harness, "team_start", { title: "Notes" });
    expect(await call(harness, "team_note", { run: started.run, kind: "rumour", text: "x" }))
      .toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("scripted pipeline", () => {
  test("drives every phase to done with gate denials, a report, and terminal state", async () => {
    const harness = await setup({ config: { reviews: { parallel: false } } });
    const started = await call(harness, "team_start", { title: "Pipeline" });
    const run = started.run as string;

    const missing = await call(harness, "team_status", { run });
    expect(missing.gate).toMatchObject({ ok: false, code: "missing_artifact" });
    expect((await call(harness, "team_advance", { run })).gate.code).toBe("missing_artifact");

    writeArtifact(harness, run, "brainstorm.md", "# Brainstorm\n");
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, from: "brainstorm", to: "spec" });

    writeArtifact(harness, run, "spec.md", footer(["STATUS: APPROVED"]));
    expect(await call(harness, "team_advance", { run })).toMatchObject({
      ok: false,
      code: "gate_denied",
      gate: { code: "missing_approval_note" },
    });
    const note = await call(harness, "team_note", {
      run,
      kind: "decision",
      text: "human_approval: the human approved the spec",
    }, { sessionID: "session-approval", agent: "team-lead", id: "call-note" });
    expect(note.ok).toBe(true);
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "plan" });

    writeArtifact(harness, run, "plan.md", "# Plan\n");
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "implement" });
    writeArtifact(harness, run, "impl-notes.md", "# Implementation\n");
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "test" });

    writeArtifact(harness, run, "test-report.md", footer(["RESULT: FAIL", "COMMAND: bun test", "EXIT: 1"]));
    expect((await call(harness, "team_advance", { run })).gate.code).toBe("test_not_passed");
    writeArtifact(harness, run, "test-report.md", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: 1"]));
    expect((await call(harness, "team_advance", { run })).gate.code).toBe("test_not_passed");
    writeArtifact(harness, run, "test-report.md", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: 0"]));
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "qa" });

    writeArtifact(harness, run, "qa.md", footer(["VERDICT: FAIL"]));
    expect((await call(harness, "team_advance", { run })).gate.code).toBe("verdict_not_pass");
    writeArtifact(harness, run, "qa.md", footer(["VERDICT: PASS"]));
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "adversary" });

    writeArtifact(harness, run, "adversary.md", footer(["BLOCKERS: 2"]));
    expect((await call(harness, "team_advance", { run })).gate.code).toBe("blockers");
    writeArtifact(harness, run, "adversary.md", footer(["BLOCKERS: 0"]));
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "docs" });

    writeArtifact(harness, run, "docs.md", "# Docs\n");
    const toRetro = await call(harness, "team_advance", { run });
    expect(toRetro).toMatchObject({ ok: true, to: "retro" });
    expect(toRetro.report_path).toBe(path.join(harness.rootDir, "runs", run, "report.md"));
    const report = readFileSync(toRetro.report_path as string, "utf8");
    expect(report).toContain("## Phase durations");
    expect(report).toContain("## Gate denials");
    expect(report).toContain("missing_approval_note");
    expect(report).toContain("human_approval: the human approved the spec");

    writeArtifact(harness, run, "retro.md", "# Retro\n");
    const proposalDirectory = path.join(harness.rootDir, "proposals");
    mkdirSync(proposalDirectory, { recursive: true });
    const proposalFile = "developer.20261031T153012Z.md";
    writeFileSync(
      path.join(proposalDirectory, proposalFile),
      "You are the complete proposed developer prompt.\n",
      "utf8",
    );
    const done = await call(harness, "team_advance", { run });
    expect(done).toMatchObject({ ok: true, from: "retro", to: "done", terminal: true });
    expect(await readRun(harness, run)).toMatchObject({ status: "closed", phase: "done" });
    const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
    try {
      expect(new PromptRepository(db).list()).toMatchObject([{
        role: "developer",
        path: `proposals/${proposalFile}`,
        status: "proposed",
        source_run: run,
        sha: expect.any(String),
      }]);
    } finally {
      db.close();
    }
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: false, code: "run_terminal" });
    const finalStatus = await call(harness, "team_status", { run });
    expect(finalStatus).toMatchObject({ status: "closed", phase: "done", gate: { ok: true } });
  });

  test("test SKIPPED is denied when the Stack Profile declares a test command", async () => {
    const harness = await setup({
      prepare: (directory) => {
        writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }), "utf8");
        writeFileSync(path.join(directory, "bun.lock"), "", "utf8");
      },
    });
    const started = await call(harness, "team_start", { title: "Skipped tests" });
    const run = started.run as string;
    const advance = async () => call(harness, "team_advance", { run });

    writeArtifact(harness, run, "brainstorm.md", "# B\n");
    await advance();
    writeArtifact(harness, run, "spec.md", footer(["STATUS: APPROVED"]));
    await call(harness, "team_note", { run, kind: "decision", text: "human_approval yes" });
    await advance();
    writeArtifact(harness, run, "plan.md", "# P\n");
    await advance();
    writeArtifact(harness, run, "impl-notes.md", "# I\n");
    await advance();

    writeArtifact(harness, run, "test-report.md", footer(["RESULT: SKIPPED"]));
    expect((await advance()).gate.code).toBe("test_skipped_with_test_command");
    await call(harness, "team_note", { run, kind: "decision", text: "Tests are temporarily unavailable." });
    expect((await advance()).gate.code).toBe("test_skipped_with_test_command");
    writeArtifact(harness, run, "test-report.md", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: 0"]));
    expect(await advance()).toMatchObject({ ok: true, to: "qa" });
  });
});

describe("loop caps and rewinds", () => {
  test("team_loop counts to maxLoops and escalates at maxLoops + 1", async () => {
    const harness = await setup({ config: { maxLoops: 2 } });
    const run = (await call(harness, "team_start", { title: "Loops" })).run as string;

    expect(await call(harness, "team_loop", { run, reason: "retry 1" }))
      .toMatchObject({ loop_count: 1, max_loops: 2, remaining: 1, escalate: false });
    expect(await call(harness, "team_loop", { run, reason: "retry 2" }))
      .toMatchObject({ loop_count: 2, remaining: 0, escalate: false });
    expect(await call(harness, "team_loop", { run, reason: "retry 3" }))
      .toMatchObject({ loop_count: 3, remaining: 0, escalate: true, action: "ESCALATE_TO_HUMAN" });

    const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
    try {
      expect(db.all<{ kind: string }>("SELECT kind FROM events ORDER BY id").map((row) => row.kind))
        .toContain("loop.exceeded");
    } finally {
      db.close();
    }
  });

  test("team_rewind re-enters an earlier phase and escalates above the cap", async () => {
    const harness = await setup({ config: { maxLoops: 3 } });
    const run = (await call(harness, "team_start", { title: "Rewinds" })).run as string;
    writeArtifact(harness, run, "brainstorm.md", "# Brainstorm\n");

    for (let index = 1; index <= 3; index += 1) {
      expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "spec" });
      expect(await call(harness, "team_rewind", { run, to: "brainstorm", reason: `pass ${index}` }))
        .toMatchObject({ ok: true, from: "spec", to: "brainstorm", loop_count: index, remaining: 3 - index });
    }

    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "spec" });
    expect(await call(harness, "team_rewind", { run, to: "brainstorm", reason: "too many" }))
      .toMatchObject({ ok: false, code: "ESCALATE_TO_HUMAN", escalation: "ESCALATE_TO_HUMAN", count: 4 });
    expect((await readRun(harness, run))?.phase).toBe("spec");

    expect(await call(harness, "team_rewind", { run, to: "spec", reason: "same phase" }))
      .toMatchObject({ ok: false, code: "invalid_transition" });
    expect(await call(harness, "team_rewind", { run, to: "done", reason: "terminal" }))
      .toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("parallel review wave", () => {
  test("explicit false keeps the sequential pipeline and advertises an empty review_wave", async () => {
    const harness = await setup({ config: { reviews: { parallel: false } } });
    const startResult = await harness.fake.invokeTool("team_start", { title: "Sequential" });
    const started = output(startResult);
    const run = started.run as string;
    expect(started.review_wave).toEqual({
      enabled: false,
      active: false,
      ready: false,
      phase: "brainstorm",
      members: [],
      artifacts: {},
      generation: 0,
    });
    const startText = (startResult.content as Array<{ text: string }>)[0]!.text;
    expect(startText).not.toContain("Parallel review wave enabled");
    expect(await call(harness, "team_loop", { run, reason: "role", role: "qa" }))
      .toMatchObject({ ok: false, code: "review_role_not_enabled" });

    const loop = await call(harness, "team_loop", { run, reason: "retry" });
    expect(loop).toMatchObject({ loop_count: 1 });
    expect(loop.role).toBeUndefined();
    const sequentialLoopEvents = (await runEvents(harness, run)).filter(
      (event) => event.kind === "loop.incremented",
    );
    expect(sequentialLoopEvents).toHaveLength(1);
    expect(sequentialLoopEvents[0].data).not.toHaveProperty("role");

    await driveToQa(harness, run);
    const inQa = await call(harness, "team_status", { run });
    expect(inQa.review_wave).toMatchObject({
      enabled: false,
      active: false,
      ready: false,
      phase: "qa",
      members: [],
      artifacts: {},
      generation: 1,
    });
    expect(inQa.loops).toEqual({ brainstorm: 1 });
    expect(inQa.role_loops).toBeUndefined();
    expect(inQa.gate).toMatchObject({ ok: false, code: "missing_artifact", artifact: "qa.md" });
    expect(inQa.gate).not.toHaveProperty("members");
    expect(await loopCounts(harness, run)).toEqual({ "brainstorm:": 1 });

    writeArtifact(harness, run, "qa.md", footer(["VERDICT: PASS"]));
    const toAdversary = await call(harness, "team_advance", { run });
    expect(toAdversary).toMatchObject({ ok: true, to: "adversary" });
    const inAdversary = await call(harness, "team_status", { run });
    expect(inAdversary.gate).toMatchObject({ ok: false, code: "missing_artifact", artifact: "adversary.md" });
    expect(inAdversary.gate).not.toHaveProperty("members");
    expect(await transitionTargets(harness, run)).toEqual([
      "brainstorm",
      "spec",
      "plan",
      "implement",
      "test",
      "qa",
      "adversary",
    ]);

    writeArtifact(harness, run, "adversary.md", footer(["BLOCKERS: 0"]));
    const toDocs = await call(harness, "team_advance", { run });
    expect(toDocs).toMatchObject({ ok: true, to: "docs" });
    const inDocs = await call(harness, "team_status", { run });
    expect(inDocs.gate).toMatchObject({ ok: false, code: "missing_artifact", artifact: "docs.md" });
    expect(inDocs.gate).not.toHaveProperty("members");
    expect(await loopCounts(harness, run)).toEqual({ "brainstorm:": 1 });
    expect(await call(harness, "team_rewind", { run, to: "adversary", reason: "sequential retry" }))
      .toMatchObject({ ok: true, from: "docs", to: "adversary" });

    const events = await runEvents(harness, run);
    expect(events.filter((event) => event.kind.startsWith("review.wave."))).toEqual([]);
    expect(events.filter((event) => event.kind === "loop.incremented").every(
      (event) => !("role" in event.data),
    )).toBe(true);
    const statusText = ((await harness.fake.invokeTool("team_status", { run })).content as Array<{ text: string }>)[0]!.text;
    expect(statusText).not.toContain("Review wave:");
  });

  test("default config enables the wave and records role loop rows", async () => {
    const harness = await setup();
    const startResult = await harness.fake.invokeTool("team_start", { title: "Default wave" });
    const started = output(startResult);
    const run = started.run as string;
    const qaPath = path.join(harness.rootDir, "runs", run, "qa.md");
    const adversaryPath = path.join(harness.rootDir, "runs", run, "adversary.md");
    expect(started.review_wave).toMatchObject({
      enabled: true,
      active: false,
      ready: false,
      phase: "brainstorm",
      generation: 0,
      artifacts: { qa: qaPath, adversary: adversaryPath },
    });
    expect((started.review_wave as any).members.map((member: any) => member.role)).toEqual(["qa", "adversary"]);
    const startText = (startResult.content as Array<{ text: string }>)[0]!.text;
    expect(startText).toContain("Parallel review wave enabled");
    expect(startText).toContain("qa -> docs");

    await driveToQa(harness, run);
    const events = await runEvents(harness, run);
    expect(events.filter((event) => event.kind === "review.wave.started")).toHaveLength(1);
    const inQa = await call(harness, "team_status", { run });
    expect(inQa.review_wave).toMatchObject({
      enabled: true,
      active: true,
      ready: false,
      phase: "qa",
      generation: 1,
    });
    expect(inQa.review_wave.members.map((member: any) => member.role)).toEqual(["qa", "adversary"]);

    expect(await call(harness, "team_loop", { run, reason: "qa retry" }, { agent: "qa" }))
      .toMatchObject({ role: "qa", loop_count: 1 });
    expect(await loopCounts(harness, run)).toEqual({ "qa:qa": 1 });
    const afterLoop = await call(harness, "team_status", { run });
    expect(afterLoop.role_loops).toEqual([
      { phase: "qa", role: "qa", count: 1, remaining: 2, escalated: false },
    ]);
  });

  test("default config runs a full wave with both member paths and advances qa -> docs", async () => {
    const harness = await setup();
    const started = output(await harness.fake.invokeTool("team_start", { title: "Default full wave" }));
    const run = started.run as string;
    const qaPath = path.join(harness.rootDir, "runs", run, "qa.md");
    const adversaryPath = path.join(harness.rootDir, "runs", run, "adversary.md");
    expect(started.review_wave).toMatchObject({
      enabled: true,
      active: false,
      artifacts: { qa: qaPath, adversary: adversaryPath },
    });

    await driveToQa(harness, run);
    const inQa = await call(harness, "team_status", { run });
    expect(inQa.review_wave).toMatchObject({
      enabled: true,
      active: true,
      ready: false,
      phase: "qa",
      generation: 1,
      artifacts: { qa: qaPath, adversary: adversaryPath },
    });
    expect(inQa.review_wave.members.map((member: any) => [member.role, member.artifact_path])).toEqual([
      ["qa", qaPath],
      ["adversary", adversaryPath],
    ]);
    expect(inQa.next_action).toContain("qa -> docs");

    expect(await call(harness, "team_loop", { run, reason: "qa retry" }, { agent: "qa" }))
      .toMatchObject({ role: "qa", loop_count: 1 });
    expect(await call(harness, "team_loop", { run, reason: "adversary retry" }, { agent: "adversary" }))
      .toMatchObject({ role: "adversary", loop_count: 1 });
    expect(await loopCounts(harness, run)).toEqual({ "qa:adversary": 1, "qa:qa": 1 });

    writeArtifact(harness, run, "qa.md", footer(["VERDICT: PASS"]));
    const denied = await call(harness, "team_advance", { run });
    expect(denied).toMatchObject({
      ok: false,
      code: "gate_denied",
      phase: "qa",
      gate: { ok: false, code: "missing_artifact", artifact: "adversary.md" },
    });
    expect(denied.gate.members.map((member: any) => [member.role, member.ok])).toEqual([
      ["qa", true],
      ["adversary", false],
    ]);
    expect((await readRun(harness, run))?.phase).toBe("qa");

    writeArtifact(harness, run, "adversary.md", footer(["BLOCKERS: 0"]));
    expect(await call(harness, "team_advance", { run }))
      .toMatchObject({ ok: true, from: "qa", to: "docs", phase: "docs" });
    expect(await transitionTargets(harness, run)).not.toContain("adversary");

    const events = await runEvents(harness, run);
    expect(events.filter((event) => event.kind === "review.wave.started")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "review.wave.denied")).toHaveLength(1);
    const completed = events.filter((event) => event.kind === "review.wave.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0].data).toMatchObject({
      phase: "qa",
      to: "docs",
      skipped: "adversary",
      members: [
        { role: "qa", artifact: "qa.md", footer: { VERDICT: "PASS" } },
        { role: "adversary", artifact: "adversary.md", footer: { BLOCKERS: "0" } },
      ],
    });
    expect(events.filter((event) => event.kind === "loop.incremented" && typeof event.data.role === "string")
      .map((event) => event.data.role)).toEqual(["qa", "adversary"]);

    const inDocs = await call(harness, "team_status", { run });
    expect(inDocs.review_wave).toMatchObject({ enabled: true, active: false, phase: "docs" });
    expect(inDocs.role_loops).toEqual([
      { phase: "qa", role: "adversary", count: 1, remaining: 2, escalated: false },
      { phase: "qa", role: "qa", count: 1, remaining: 2, escalated: false },
    ]);
  });

  test("enabled wave evaluates both reviewers, aggregates denials, and advances qa -> docs", async () => {
    const harness = await setup({ config: { reviews: { parallel: true } } });
    const startResult = await harness.fake.invokeTool("team_start", { title: "Wave" });
    const started = output(startResult);
    const run = started.run as string;
    const qaPath = path.join(harness.rootDir, "runs", run, "qa.md");
    const adversaryPath = path.join(harness.rootDir, "runs", run, "adversary.md");
    expect(started.review_wave).toMatchObject({
      enabled: true,
      active: false,
      ready: false,
      phase: "brainstorm",
      generation: 0,
      artifacts: { qa: qaPath, adversary: adversaryPath },
    });
    expect((started.review_wave as any).members.map((member: any) => member.role)).toEqual(["qa", "adversary"]);
    const startText = (startResult.content as Array<{ text: string }>)[0]!.text;
    expect(startText).toContain("Parallel review wave enabled");
    expect(startText).toContain("qa -> docs");

    await driveToQa(harness, run);

    const events = await runEvents(harness, run);
    const startedEvents = events.filter((event) => event.kind === "review.wave.started");
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].data).toMatchObject({
      phase: "qa",
      members: ["qa", "adversary"],
      cause: "advance",
      generation: 1,
      max_loops: 3,
    });
    expect(startedEvents[0].data.artifacts).toEqual({ qa: qaPath, adversary: adversaryPath });

    const inQa = await call(harness, "team_status", { run });
    expect(inQa.review_wave).toMatchObject({
      enabled: true,
      active: true,
      ready: false,
      phase: "qa",
      generation: 1,
    });
    expect(inQa.review_wave.members).toHaveLength(2);
    expect(inQa.review_wave.members[0]).toMatchObject({
      role: "qa",
      artifact: "qa.md",
      artifact_path: qaPath,
      gate: { ok: false, code: "missing_artifact" },
      loop: { count: 0, remaining: 3, escalated: false },
    });
    expect(inQa.review_wave.members[1]).toMatchObject({
      role: "adversary",
      artifact: "adversary.md",
      artifact_path: adversaryPath,
      gate: { ok: false, code: "missing_artifact" },
    });
    expect(inQa.gate).toMatchObject({ ok: false, code: "missing_artifact", members: expect.any(Array) });
    expect(inQa.next_action).toContain("qa (qa.md)");
    expect(inQa.next_action).toContain("adversary (adversary.md)");
    expect(inQa.next_action).toContain("qa -> docs");
    const inQaText = ((await harness.fake.invokeTool("team_status", { run })).content as Array<{ text: string }>)[0]!.text;
    expect(inQaText).toContain("Review wave: active in qa; not ready; generation 1");

    writeArtifact(harness, run, "qa.md", footer(["VERDICT: PASS"]));
    const missingAdversary = await call(harness, "team_advance", { run });
    expect(missingAdversary).toMatchObject({
      ok: false,
      code: "gate_denied",
      phase: "qa",
      gate: { ok: false, code: "missing_artifact", artifact: "adversary.md", artifact_path: adversaryPath },
    });
    expect(missingAdversary.gate.members).toHaveLength(2);
    expect(missingAdversary.gate.members.map((member: any) => member.ok)).toEqual([true, false]);
    expect((await readRun(harness, run))?.phase).toBe("qa");

    const afterDenial = await runEvents(harness, run);
    const deniedEvents = afterDenial.filter((event) => event.kind === "review.wave.denied");
    expect(deniedEvents).toHaveLength(1);
    expect(deniedEvents[0].data).toMatchObject({
      phase: "qa",
      gate_code: "missing_artifact",
      ready: false,
      generation: 1,
    });
    expect(deniedEvents[0].data.failing_members).toEqual([
      {
        role: "adversary",
        code: "missing_artifact",
        artifact: "adversary.md",
        artifact_path: adversaryPath,
        message: expect.any(String),
      },
    ]);

    writeArtifact(harness, run, "adversary.md", footer(["BLOCKERS: 2"]));
    const blockers = await call(harness, "team_advance", { run });
    expect(blockers).toMatchObject({ ok: false, code: "gate_denied", gate: { code: "blockers", artifact: "adversary.md" } });
    expect(blockers.gate.members.map((member: any) => member.code)).toEqual(["ok", "blockers"]);

    writeArtifact(harness, run, "adversary.md", footer(["BLOCKERS: 0"]));
    const advanced = await call(harness, "team_advance", { run });
    expect(advanced).toMatchObject({ ok: true, from: "qa", to: "docs", phase: "docs" });

    const completedEvents = (await runEvents(harness, run)).filter((event) => event.kind === "review.wave.completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].data).toMatchObject({
      phase: "qa",
      to: "docs",
      skipped: "adversary",
      generation: 1,
      members: [
        { role: "qa", artifact: "qa.md", artifact_path: qaPath, footer: { VERDICT: "PASS" } },
        { role: "adversary", artifact: "adversary.md", artifact_path: adversaryPath, footer: { BLOCKERS: "0" } },
      ],
    });
    expect(completedEvents[0].data.duration_ms).toBeGreaterThanOrEqual(0);

    const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
    try {
      const transitions = new RunRepository(db).getTransitions(run);
      expect(transitions.map((transition) => transition.to_phase)).not.toContain("adversary");
    } finally {
      db.close();
    }

    const inDocs = await call(harness, "team_status", { run });
    expect(inDocs.review_wave).toMatchObject({ enabled: true, active: false, ready: false, phase: "docs" });
    expect(inDocs.review_wave.members.every((member: any) => member.gate === null)).toBe(true);

    expect((await call(harness, "team_advance", { run })).gate.code).toBe("missing_artifact");
    writeArtifact(harness, run, "docs.md", "# Docs\n");
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "retro" });
    writeArtifact(harness, run, "retro.md", "# Retro\n");
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "done", terminal: true });
  });

  test("denies either missing member and aggregates both failures without changing state or loops", async () => {
    const harness = await setup({ config: { reviews: { parallel: true } } });
    const run = (await call(harness, "team_start", { title: "Wave denials" })).run as string;
    const qaPath = path.join(harness.rootDir, "runs", run, "qa.md");
    const adversaryPath = path.join(harness.rootDir, "runs", run, "adversary.md");
    await driveToQa(harness, run);

    const transitionsBefore = await transitionTargets(harness, run);
    const loopsBefore = await loopCounts(harness, run);
    expect(loopsBefore).toEqual({});

    writeArtifact(harness, run, "adversary.md", footer(["BLOCKERS: 0"]));
    const missingQa = await call(harness, "team_advance", { run });
    expect(missingQa).toMatchObject({
      ok: false,
      code: "gate_denied",
      phase: "qa",
      gate: { ok: false, code: "missing_artifact", artifact: "qa.md", artifact_path: qaPath },
    });
    expect(missingQa.gate.members.map((member: any) => [member.role, member.ok, member.code])).toEqual([
      ["qa", false, "missing_artifact"],
      ["adversary", true, "ok"],
    ]);
    expect(missingQa.gate.members[1].footer).toEqual({ BLOCKERS: "0" });
    expect((await readRun(harness, run))?.phase).toBe("qa");

    let denied = (await runEvents(harness, run)).filter((event) => event.kind === "review.wave.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].data.failing_members).toEqual([
      {
        role: "qa",
        code: "missing_artifact",
        artifact: "qa.md",
        artifact_path: qaPath,
        message: expect.any(String),
      },
    ]);

    writeArtifact(harness, run, "qa.md", footer(["VERDICT: FAIL"]));
    writeArtifact(harness, run, "adversary.md", footer(["BLOCKERS: 2"]));
    const both = await call(harness, "team_advance", { run });
    expect(both).toMatchObject({
      ok: false,
      code: "gate_denied",
      phase: "qa",
      gate: {
        ok: false,
        code: "verdict_not_pass",
        artifact: "qa.md",
        artifact_path: qaPath,
        footer: { VERDICT: "FAIL" },
      },
    });
    expect(both.gate.members.map((member: any) => member.code)).toEqual(["verdict_not_pass", "blockers"]);
    expect(both.gate.members.map((member: any) => member.ok)).toEqual([false, false]);
    expect(both.gate.members[1].artifact_path).toBe(adversaryPath);

    denied = (await runEvents(harness, run)).filter((event) => event.kind === "review.wave.denied");
    expect(denied).toHaveLength(2);
    expect(denied[1].data).toMatchObject({ gate_code: "verdict_not_pass", ready: false, generation: 1 });
    expect(denied[1].data.failing_members.map((member: any) => member.role)).toEqual(["qa", "adversary"]);
    expect(denied[1].data.failing_members.map((member: any) => member.code)).toEqual([
      "verdict_not_pass",
      "blockers",
    ]);

    expect(await loopCounts(harness, run)).toEqual(loopsBefore);
    expect(await transitionTargets(harness, run)).toEqual(transitionsBefore);
    expect((await readRun(harness, run))?.phase).toBe("qa");
  });

  test("accepts sequentially written artifacts as the fallback path", async () => {
    const harness = await setup({ config: { reviews: { parallel: true } } });
    const run = (await call(harness, "team_start", { title: "Wave fallback" })).run as string;
    await driveToQa(harness, run);

    writeArtifact(harness, run, "qa.md", footer(["VERDICT: PASS"]));
    let status = await call(harness, "team_status", { run });
    expect(status.review_wave).toMatchObject({ enabled: true, active: true, ready: false });
    expect(status.review_wave.members[0].gate).toMatchObject({ ok: true, code: "ok" });
    expect(status.review_wave.members[1].gate).toMatchObject({ ok: false, code: "missing_artifact" });
    expect(status.next_action).toContain("adversary");

    writeArtifact(harness, run, "adversary.md", footer(["BLOCKERS: 0"]));
    status = await call(harness, "team_status", { run });
    expect(status.review_wave).toMatchObject({ enabled: true, active: true, ready: true });
    expect(status.review_wave.members.map((member: any) => member.gate?.ok)).toEqual([true, true]);
    expect(status.next_action).toContain("team_advance");

    expect(await call(harness, "team_advance", { run }))
      .toMatchObject({ ok: true, from: "qa", to: "docs", phase: "docs" });
  });

  test("accepts an explicit matching reviewer role and rejects an invalid role value", async () => {
    const harness = await setup({ config: { reviews: { parallel: true } } });
    const run = (await call(harness, "team_start", { title: "Explicit role" })).run as string;
    await driveToQa(harness, run);

    expect(await call(harness, "team_loop", { run, reason: "same role", role: "qa" }, { agent: "qa" }))
      .toMatchObject({ ok: true, role: "qa", loop_count: 1, remaining: 2, escalate: false });
    expect(await call(harness, "team_loop", { run, reason: "bad value", role: "tester" }, { agent: "qa" }))
      .toMatchObject({ ok: false, code: "invalid_input" });
    expect(await loopCounts(harness, run)).toEqual({ "qa:qa": 1 });

    const events = await runEvents(harness, run);
    const incremented = events.filter((event) => event.kind === "loop.incremented");
    expect(incremented[0].data).toMatchObject({ phase: "qa", role: "qa", agent: "qa" });
  });

  test("keeps phase-level loop keys outside the active wave", async () => {
    const enabled = await setup({ config: { reviews: { parallel: true } } });
    const run = (await call(enabled, "team_start", { title: "Phase loop" })).run as string;
    const phaseLoop = await call(enabled, "team_loop", { run, reason: "phase-level" }, { agent: "team-lead" });
    expect(phaseLoop).toMatchObject({ ok: true, loop_count: 1 });
    expect(phaseLoop.role).toBeUndefined();
    expect(await loopCounts(enabled, run)).toEqual({ "brainstorm:": 1 });

    const sequential = await setup({ config: { reviews: { parallel: false } } });
    const sequentialRun = (await call(sequential, "team_start", { title: "Sequential qa" })).run as string;
    await driveToQa(sequential, sequentialRun);
    expect(await call(sequential, "team_loop", { run: sequentialRun, reason: "qa retry" }, { agent: "qa" }))
      .toMatchObject({ ok: true, loop_count: 1 });
    expect(await loopCounts(sequential, sequentialRun)).toEqual({ "qa:": 1 });
  });

  test("wave rewind blocks adversary, restarts qa with the wave counter, and escalates at the cap", async () => {
    const harness = await setup({ config: { reviews: { parallel: true }, maxLoops: 2 } });
    const run = (await call(harness, "team_start", { title: "Wave rewind" })).run as string;
    await driveToQa(harness, run);

    expect(await call(harness, "team_loop", { run, reason: "qa retry" }, { agent: "qa" }))
      .toMatchObject({ role: "qa", loop_count: 1 });
    const beforeGuard = await loopCounts(harness, run);
    expect(beforeGuard).toEqual({ "qa:qa": 1 });

    const blocked = await call(harness, "team_rewind", { run, to: "adversary", reason: "try adversary" });
    expect(blocked).toMatchObject({ ok: false, code: "review_wave_rewind_blocked" });
    expect(blocked.error).toContain("Rewind to qa");
    expect(blocked.error).toContain("implement");
    expect((await readRun(harness, run))?.phase).toBe("qa");
    expect(await loopCounts(harness, run)).toEqual(beforeGuard);

    writeArtifact(harness, run, "qa.md", footer(["VERDICT: PASS"]));
    writeArtifact(harness, run, "adversary.md", footer(["BLOCKERS: 0"]));
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "docs" });

    const firstRewind = await call(harness, "team_rewind", { run, to: "qa", reason: "restart wave" });
    expect(firstRewind).toMatchObject({
      ok: true,
      from: "docs",
      to: "qa",
      scope: "wave",
      loop_count: 1,
    });
    expect(firstRewind.review_generation).toBe(2);
    expect(await loopCounts(harness, run)).toEqual({ "qa:": 1, "qa:qa": 1 });
    const rewindEventKinds = (await runEvents(harness, run)).map((event) => event.kind);
    expect(rewindEventKinds.slice(-3)).toEqual(["loop.incremented", "phase.rewound", "review.wave.started"]);
    const rewoundEvents = (await runEvents(harness, run)).filter((event) => event.kind === "review.wave.started");
    expect(rewoundEvents).toHaveLength(2);
    expect(rewoundEvents[1].data).toMatchObject({ phase: "qa", cause: "rewind", generation: 2, max_loops: 2 });

    // Previously passing artifacts are stale-but-accepted by design; the barrier passes.
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "docs" });
    expect(await call(harness, "team_rewind", { run, to: "qa", reason: "restart again" }))
      .toMatchObject({ ok: true, loop_count: 2, review_generation: 3 });

    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: true, to: "docs" });
    const escalationsBefore = (await runEvents(harness, run)).filter((event) => event.kind === "review.wave.started").length;
    const exceeded = await call(harness, "team_rewind", { run, to: "qa", reason: "too many" });
    expect(exceeded).toMatchObject({
      ok: false,
      code: "ESCALATE_TO_HUMAN",
      escalation: "ESCALATE_TO_HUMAN",
      phase: "qa",
      count: 3,
    });
    expect((await readRun(harness, run))?.phase).toBe("docs");
    const escalationsAfter = (await runEvents(harness, run)).filter((event) => event.kind === "review.wave.started").length;
    expect(escalationsAfter).toBe(escalationsBefore);
  });

  test("role-scoped loops infer reviewers, reject invalid calls, and escalate per role", async () => {
    const harness = await setup({ config: { reviews: { parallel: true }, maxLoops: 2 } });
    const run = (await call(harness, "team_start", { title: "Role loops" })).run as string;
    expect(await call(harness, "team_loop", { run, reason: "early", role: "qa" }))
      .toMatchObject({ ok: false, code: "review_role_out_of_phase" });

    await driveToQa(harness, run);

    expect(await call(harness, "team_loop", { run, reason: "lead no role" }, { agent: "team-lead" }))
      .toMatchObject({ ok: false, code: "review_role_required" });
    expect(await loopCounts(harness, run)).toEqual({});

    expect(await call(harness, "team_loop", { run, reason: "qa retry" }, { agent: "qa" }))
      .toMatchObject({ role: "qa", loop_count: 1, remaining: 1, escalate: false });
    expect(await call(harness, "team_loop", { run, reason: "adversary retry" }, { agent: "adversary" }))
      .toMatchObject({ role: "adversary", loop_count: 1, remaining: 1, escalate: false });

    expect(await call(harness, "team_loop", { run, reason: "wrong role", role: "adversary" }, { agent: "qa" }))
      .toMatchObject({ ok: false, code: "review_role_mismatch" });
    expect(await loopCounts(harness, run)).toEqual({ "qa:adversary": 1, "qa:qa": 1 });

    expect(await call(harness, "team_loop", { run, reason: "lead charges qa", role: "qa" }, { agent: "team-lead" }))
      .toMatchObject({ role: "qa", loop_count: 2, escalate: false });

    const qaEscalation = await call(harness, "team_loop", { run, reason: "qa third" }, { agent: "qa" });
    expect(qaEscalation).toMatchObject({
      role: "qa",
      loop_count: 3,
      remaining: 0,
      escalate: true,
      action: "ESCALATE_TO_HUMAN",
    });
    expect(qaEscalation.error).toBeUndefined();
    expect(await call(harness, "team_loop", { run, reason: "adversary second" }, { agent: "adversary" }))
      .toMatchObject({ role: "adversary", loop_count: 2, escalate: false });

    const status = await call(harness, "team_status", { run });
    expect(status.loops).toEqual({});
    expect(status.role_loops).toEqual([
      { phase: "qa", role: "adversary", count: 2, remaining: 0, escalated: false },
      { phase: "qa", role: "qa", count: 3, remaining: 0, escalated: true },
    ]);
    expect(status.counters.loops).toBe(5);
    expect(status.review_wave.members[0].loop).toEqual({ count: 3, remaining: 0, escalated: true });
    expect(status.review_wave.members[1].loop).toEqual({ count: 2, remaining: 0, escalated: false });

    const events = await runEvents(harness, run);
    const qaLoops = events.filter((event) => event.kind === "loop.incremented" && event.data.role === "qa");
    const adversaryLoops = events.filter((event) => event.kind === "loop.incremented" && event.data.role === "adversary");
    expect(qaLoops).toHaveLength(3);
    expect(adversaryLoops).toHaveLength(2);
    expect(events.find((event) => event.kind === "loop.exceeded")?.data).toMatchObject({ role: "qa", count: 3 });

    const sequential = await setup({ config: { reviews: { parallel: false } } });
    const sequentialRun = (await call(sequential, "team_start", { title: "No wave" })).run as string;
    expect(await call(sequential, "team_loop", { run: sequentialRun, reason: "role", role: "qa" }))
      .toMatchObject({ ok: false, code: "review_role_not_enabled" });
    expect(await call(sequential, "team_loop", { run: sequentialRun, reason: "plain" }))
      .toMatchObject({ loop_count: 1 });
  });
});

describe("disabled review roles", () => {
  const configurations = [
    {
      label: "default reviews.parallel",
      makeConfig: (disabled: string[]) => ({ roles: { disabled } }),
    },
    {
      label: "explicit reviews.parallel=false",
      makeConfig: (disabled: string[]) => ({ roles: { disabled }, reviews: { parallel: false } }),
    },
  ];

  for (const { label, makeConfig } of configurations) {
    test(`skips a disabled adversary and advances test -> qa -> docs (${label})`, async () => {
      const harness = await setup({ config: makeConfig(["adversary"]) });
      const run = (await call(harness, "team_start", { title: "No adversary" })).run as string;
      await driveToTest(harness, run);
      writeArtifact(harness, run, "test-report.md", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: 0"]));
      expect(await call(harness, "team_advance", { run }))
        .toMatchObject({ ok: true, from: "test", to: "qa" });

      const inQa = await call(harness, "team_status", { run });
      expect(inQa.gate).toMatchObject({ ok: false, code: "missing_artifact", artifact: "qa.md" });
      expect(inQa.gate).not.toHaveProperty("members");
      expect(inQa.review_wave).toMatchObject({ enabled: false, active: false, members: [] });
      expect(inQa.next_action.toLowerCase()).toContain("skip");
      expect(inQa.next_action).toContain("adversary");

      writeArtifact(harness, run, "qa.md", footer(["VERDICT: PASS"]));
      const toDocs = await call(harness, "team_advance", { run });
      expect(toDocs).toMatchObject({ ok: true, from: "qa", to: "docs", skipped: ["adversary"] });
      expect(await transitionTargets(harness, run)).toEqual([
        "brainstorm",
        "spec",
        "plan",
        "implement",
        "test",
        "qa",
        "docs",
      ]);
      expect((await runEvents(harness, run)).filter((event) => event.kind.startsWith("review.wave."))).toEqual([]);
    });

    test(`skips a disabled qa and advances test -> adversary -> docs (${label})`, async () => {
      const harness = await setup({ config: makeConfig(["qa"]) });
      const run = (await call(harness, "team_start", { title: "No qa" })).run as string;
      await driveToTest(harness, run);
      writeArtifact(harness, run, "test-report.md", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: 0"]));

      const atTest = await call(harness, "team_status", { run });
      expect(atTest.gate).toMatchObject({ ok: true, artifact: "test-report.md" });
      expect(atTest.next_action.toLowerCase()).toContain("skip");
      expect(atTest.next_action).toContain("qa");
      expect(atTest.next_action).toContain("adversary");

      const toAdversary = await call(harness, "team_advance", { run });
      expect(toAdversary).toMatchObject({ ok: true, from: "test", to: "adversary", skipped: ["qa"] });
      const inAdversary = await call(harness, "team_status", { run });
      expect(inAdversary.gate).toMatchObject({ ok: false, code: "missing_artifact", artifact: "adversary.md" });
      expect(inAdversary.gate).not.toHaveProperty("members");
      expect(inAdversary.review_wave).toMatchObject({ enabled: false, active: false, members: [] });

      writeArtifact(harness, run, "adversary.md", footer(["BLOCKERS: 0"]));
      const toDocs = await call(harness, "team_advance", { run });
      expect(toDocs).toMatchObject({ ok: true, from: "adversary", to: "docs" });
      expect(toDocs.skipped).toBeUndefined();
      expect(await transitionTargets(harness, run)).toEqual([
        "brainstorm",
        "spec",
        "plan",
        "implement",
        "test",
        "adversary",
        "docs",
      ]);
    });

    test(`skips both disabled review roles and advances test -> docs (${label})`, async () => {
      const harness = await setup({ config: makeConfig(["qa", "adversary"]) });
      const run = (await call(harness, "team_start", { title: "No review roles" })).run as string;
      await driveToTest(harness, run);
      writeArtifact(harness, run, "test-report.md", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: 0"]));

      const atTest = await call(harness, "team_status", { run });
      expect(atTest.gate).toMatchObject({ ok: true, artifact: "test-report.md" });
      expect(atTest.next_action.toLowerCase()).toContain("skip");
      expect(atTest.next_action).toContain("qa");
      expect(atTest.next_action).toContain("adversary");

      const toDocs = await call(harness, "team_advance", { run });
      expect(toDocs).toMatchObject({
        ok: true,
        from: "test",
        to: "docs",
        phase: "docs",
        skipped: ["qa", "adversary"],
      });
      expect(await transitionTargets(harness, run)).toEqual([
        "brainstorm",
        "spec",
        "plan",
        "implement",
        "test",
        "docs",
      ]);
      const inDocs = await call(harness, "team_status", { run });
      expect(inDocs.gate).toMatchObject({ ok: false, code: "missing_artifact", artifact: "docs.md" });
      expect(inDocs.review_wave).toMatchObject({ enabled: false, active: false, members: [] });
    });

    test(`rejects rewinds to a disabled review role before state or loop changes (${label})`, async () => {
      const adversaryDisabled = await setup({ config: makeConfig(["adversary"]) });
      const adversaryRun = (await call(adversaryDisabled, "team_start", { title: "Rewind adversary" })).run as string;
      await driveToQa(adversaryDisabled, adversaryRun);
      const blockedAdversary = await call(adversaryDisabled, "team_rewind", {
        run: adversaryRun,
        to: "adversary",
        reason: "inspect adversary",
      });
      expect(blockedAdversary).toMatchObject({ ok: false, code: "review_role_disabled" });
      expect(blockedAdversary.error).toContain("adversary");
      expect(blockedAdversary.error).toContain("disabled");
      expect((await readRun(adversaryDisabled, adversaryRun))?.phase).toBe("qa");
      expect(await loopCounts(adversaryDisabled, adversaryRun)).toEqual({});

      const qaDisabled = await setup({ config: makeConfig(["qa"]) });
      const qaRun = (await call(qaDisabled, "team_start", { title: "Rewind qa" })).run as string;
      await driveToTest(qaDisabled, qaRun);
      writeArtifact(qaDisabled, qaRun, "test-report.md", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: 0"]));
      expect(await call(qaDisabled, "team_advance", { run: qaRun }))
        .toMatchObject({ ok: true, to: "adversary" });
      const blockedQa = await call(qaDisabled, "team_rewind", {
        run: qaRun,
        to: "qa",
        reason: "inspect qa",
      });
      expect(blockedQa).toMatchObject({ ok: false, code: "review_role_disabled" });
      expect(blockedQa.error).toContain("qa");
      expect(blockedQa.error).toContain("disabled");
      expect((await readRun(qaDisabled, qaRun))?.phase).toBe("adversary");
      expect(await loopCounts(qaDisabled, qaRun)).toEqual({});
    });
  }
});

describe("run resolution and stack tools", () => {
  test("resolves explicit, session, parent-session, single-open, ambiguous, and missing runs", async () => {
    const harness = await setup();
    expect(await call(harness, "team_status", {}, { sessionID: "nobody" }))
      .toMatchObject({ ok: false, code: "run_not_found" });

    const first = await call(harness, "team_start", { title: "First" }, { sessionID: "session-a" });
    expect(await call(harness, "team_status", {}, { sessionID: "session-a" }))
      .toMatchObject({ ok: true, run: first.run });
    expect(await call(harness, "team_status", { run: first.run }, { sessionID: "unknown" }))
      .toMatchObject({ ok: true, run: first.run });

    const second = await call(harness, "team_start", { title: "Second" }, { sessionID: "session-b" });
    expect(await call(harness, "team_status", {}, { sessionID: "stranger" }))
      .toMatchObject({ ok: false, code: "run_ambiguous" });
    expect((await call(harness, "team_stack", {}, { sessionID: "stranger-2" })).code).toBe("run_ambiguous");
    expect(await call(harness, "team_status", { run: second.run }, { sessionID: "unknown" }))
      .toMatchObject({ ok: true, run: second.run });

    const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
    try {
      new RunRepository(db).upsertSession({ id: "child-a", parentId: "session-a", agent: "developer" });
    } finally {
      db.close();
    }
    expect(await call(harness, "team_status", {}, { sessionID: "child-a" }))
      .toMatchObject({ ok: true, run: first.run });

    const single = await setup();
    const only = await call(single, "team_start", { title: "Only" }, { sessionID: "lead" });
    expect(await call(single, "team_status", {}, { sessionID: "other" }))
      .toMatchObject({ ok: true, run: only.run });
    const connection = await openDatabase(path.join(single.rootDir, "team.db"));
    try {
      expect(new RunRepository(connection.db).getSession("other")?.run_id).toBe(only.run);
    } finally {
      connection.db.close();
    }
  });

  test("team_stack resolves and persists, team_stack_update patches, and human files win", async () => {
    const harness = await setup({
      prepare: (directory) => {
        writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }), "utf8");
        writeFileSync(path.join(directory, "bun.lock"), "", "utf8");
      },
    });
    const run = (await call(harness, "team_start", { title: "Stack" })).run as string;

    const resolved = await call(harness, "team_stack", { run });
    expect(resolved).toMatchObject({
      ok: true,
      layer: "detected",
      sources: ["detected"],
      persisted: true,
      globs_defaulted: false,
    });
    expect(resolved.profile.components[0].commands.test).toBe("bun run test");
    expect(JSON.parse(readFileSync(path.join(harness.rootDir, "runs", run, "stack.json"), "utf8")))
      .toEqual(resolved.profile);

    const updated = await call(harness, "team_stack_update", {
      run,
      patch: { components: [{ name: "root", commands: { test: "custom test" }, globs: { tests: ["spec/**"], docs: ["docs/**"] } }] },
    });
    expect(updated).toMatchObject({ ok: true, layer: "run" });
    expect(updated.profile.source).toBe("researcher");
    expect(updated.profile.components[0].commands.test).toBe("custom test");
    const reread = await call(harness, "team_stack", { run });
    expect(reread).toMatchObject({ layer: "run", sources: ["run"] });
    expect(reread.profile.components[0].commands.test).toBe("custom test");

    writeFileSync(path.join(harness.rootDir, "stack.json"), JSON.stringify({
      version: 1,
      source: "human",
      components: [{ name: "human", commands: { test: "human test" } }],
    }), "utf8");
    expect(await call(harness, "team_stack", { run })).toMatchObject({ layer: "human", sources: ["human"] });
    const denied = await call(harness, "team_stack_update", {
      run,
      patch: { components: [{ name: "other", commands: { test: "other" } }] },
    });
    expect(denied).toMatchObject({ ok: false, code: "human_owned_field" });
    expect(denied.conflicts).toEqual(["components"]);
  });
});

describe("run statuses and scope defaults", () => {
  test("records default scope globs when the profile has none", async () => {
    const harness = await setup();
    const run = (await call(harness, "team_start", { title: "Defaults" })).run as string;
    const stack = await call(harness, "team_stack", { run });
    expect(stack).toMatchObject({ ok: true, globs_defaulted: true });
    expect(stack.profile.components).toEqual([]);

    const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
    try {
      const event = db.get<{ data_json: string }>(
        "SELECT data_json FROM events WHERE run_id = ? AND kind = 'gate.scope_default'",
        [run],
      );
      expect(JSON.parse(event?.data_json ?? "{}")).toMatchObject({
        profile_source: "detected",
        tests: expect.arrayContaining(["**/*.test.*"]),
        docs: expect.arrayContaining(["README*"]),
      });
    } finally {
      db.close();
    }
  });

  test("rejects advances, rewinds, and loops for blocked or aborted runs", async () => {
    const harness = await setup();
    const run = (await call(harness, "team_start", { title: "Blocked" })).run as string;

    const { db } = await openDatabase(path.join(harness.rootDir, "team.db"));
    try {
      db.run("UPDATE runs SET status = 'blocked' WHERE id = ?", [run]);
    } finally {
      db.close();
    }
    expect(await call(harness, "team_status", { run })).toMatchObject({ status: "blocked" });
    expect(await call(harness, "team_advance", { run })).toMatchObject({ ok: false, code: "run_not_open" });
    expect(await call(harness, "team_rewind", { run, to: "brainstorm", reason: "blocked" }))
      .toMatchObject({ ok: false, code: "run_not_open" });
    expect(await call(harness, "team_loop", { run, reason: "blocked" }))
      .toMatchObject({ ok: false, code: "run_not_open" });
  });
});

describe("database unavailable behavior", () => {
  test("setup stays loaded and tool calls fail cleanly", async () => {
    const projectDir = tempProject((directory) => {
      mkdirSync(path.join(directory, ".team", "team.db"), { recursive: true });
    });
    const harness = await setup({ projectDir });
    const snapshot = getDeliveryTeamSnapshot(harness.fake.context);
    expect(snapshot?.database.status).toBe("unavailable");
    expect(snapshot?.database.error).toBeTruthy();
    expect(snapshot?.setupWarnings.some((warning) => warning.startsWith("database.open:"))).toBe(true);
    expect(harness.fake.state.tools.size).toBe(10);

    expect(await call(harness, "team_start", { title: "No db" }))
      .toMatchObject({ ok: false, code: "database_unavailable" });
  });
});
