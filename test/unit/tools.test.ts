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
      schemaVersion: 2,
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
    const harness = await setup();
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
    expect(harness.fake.state.tools.size).toBe(9);

    expect(await call(harness, "team_start", { title: "No db" }))
      .toMatchObject({ ok: false, code: "database_unavailable" });
  });
});
