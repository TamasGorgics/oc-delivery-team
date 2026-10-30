import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import deliveryTeam, { getDeliveryTeamSnapshot } from "../../src/index";
import { parseConfig } from "../../src/config";
import { createGateHandler, GateDenial, type ToolBeforeEvent } from "../../src/hooks/gate";
import { openDatabase, type TeamDatabase } from "../../src/state/db";
import { LessonsRepository } from "../../src/state/lessons";
import type { Phase } from "../../src/state/phases";
import { RunRepository, type RunRow } from "../../src/state/runs";
import { Tracer } from "../../src/state/trace";
import type { ToolRuntime } from "../../src/tools/runtime";
import { createFakeContext, type FakeContextHarness } from "../fakes/ctx";

interface GateHarness {
  readonly projectDir: string;
  readonly rootDir: string;
  readonly db: TeamDatabase;
  readonly runs: RunRepository;
  readonly runtime: ToolRuntime;
}

const directories: string[] = [];
const harnesses: GateHarness[] = [];
const pluginCleanups: Array<() => void | Promise<void>> = [];
let callCounter = 0;

afterEach(async () => {
  for (const cleanup of pluginCleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Tests may deliberately break registration; cleanup stays best-effort.
    }
  }
  for (const harness of harnesses.splice(0)) {
    try {
      harness.db.close();
    } catch {
      // Closing a deliberately closed database is a no-op in the wrapper.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempProject(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-gate-"));
  directories.push(directory);
  return directory;
}

async function createGateHarness(config?: unknown): Promise<GateHarness> {
  const projectDir = tempProject();
  const parsed = parseConfig(config, projectDir);
  const opened = await openDatabase(parsed.dbPath);
  const runs = new RunRepository(opened.db);
  const runtime: ToolRuntime = {
    config: parsed,
    db: opened.db,
    trace: new Tracer(opened.db, undefined, () => {}),
    runs,
    lessons: new LessonsRepository(opened.db),
    modelSnapshot: { roles: {}, events: [] },
  };
  const harness: GateHarness = {
    projectDir,
    rootDir: parsed.rootDir,
    db: opened.db,
    runs,
    runtime,
  };
  harnesses.push(harness);
  return harness;
}

function startRun(harness: GateHarness, phase: Phase = "brainstorm", id = "run-one"): RunRow {
  const run = harness.runs.createRun({
    id,
    title: id,
    sessionId: "session-1",
    projectDir: harness.projectDir,
    phase,
  });
  harness.runs.bindSession("session-1", run.id, "team-lead");
  return run;
}

function setProfile(harness: GateHarness, run: RunRow, tests: readonly string[], docs: readonly string[]): void {
  harness.runs.setStackJson(run.id, JSON.stringify({
    version: 1,
    source: "researcher",
    components: [{
      name: "root",
      globs: { source: ["src/**"], tests, docs, ignore: [] },
    }],
  }));
}

function event(
  tool: string,
  input: unknown,
  overrides: Partial<Omit<ToolBeforeEvent, "tool" | "input">> = {},
): ToolBeforeEvent {
  callCounter += 1;
  return {
    tool,
    sessionID: "session-1",
    agent: "developer",
    messageID: "message-1",
    id: `call-${callCounter}`,
    input,
    ...overrides,
  };
}

function denial(run: () => void): GateDenial {
  try {
    run();
  } catch (error) {
    if (error instanceof GateDenial) return error;
    throw error;
  }
  throw new Error("Expected the gate to deny the tool call.");
}

async function asyncDenial(run: () => Promise<void>): Promise<GateDenial> {
  try {
    await run();
  } catch (error) {
    if (error instanceof GateDenial) return error;
    throw error;
  }
  throw new Error("Expected the gate to deny the tool call.");
}

function events(harness: GateHarness, kind: string, runId?: string): Array<Record<string, unknown>> {
  const rows = runId
    ? harness.db.all<{ data_json: string | null }>(
      "SELECT data_json FROM events WHERE kind = ? AND run_id = ? ORDER BY id",
      [kind, runId],
    )
    : harness.db.all<{ data_json: string | null }>(
      "SELECT data_json FROM events WHERE kind = ? ORDER BY id",
      [kind],
    );
  return rows.map((row) => JSON.parse(row.data_json ?? "{}") as Record<string, unknown>);
}

async function setupPlugin(options?: unknown): Promise<{ fake: FakeContextHarness; cleanup: () => void | Promise<void> }> {
  const fake = createFakeContext({
    projectDirectory: tempProject(),
    ...(options === undefined ? {} : { options }),
  });
  const cleanup = await deliveryTeam.setup(fake.context);
  if (typeof cleanup !== "function") throw new Error("Plugin setup did not return a cleanup function.");
  pluginCleanups.push(cleanup);
  return { fake, cleanup };
}

describe("gate registration", () => {
  test("registers the hook only when gating is enabled and disposes it", async () => {
    const disabled = createFakeContext({
      projectDirectory: tempProject(),
      options: { gating: { enabled: false } },
    });
    const cleanupDisabled = await deliveryTeam.setup(disabled.context);
    if (typeof cleanupDisabled !== "function") throw new Error("Missing cleanup function.");
    expect(disabled.state.toolBeforeHooks).toHaveLength(0);
    await cleanupDisabled();

    const { fake, cleanup } = await setupPlugin();
    expect(fake.state.toolBeforeHooks).toHaveLength(1);
    await cleanup();
    expect(fake.state.toolBeforeHooks).toHaveLength(0);
  });

  test("keeps setup alive when gate registration fails", async () => {
    const fake = createFakeContext({ projectDirectory: tempProject() });
    const tool = fake.context.tool as unknown as { hook: () => Promise<never> };
    tool.hook = async () => {
      throw new Error("hooks unavailable");
    };

    const cleanup = await deliveryTeam.setup(fake.context);
    if (typeof cleanup !== "function") throw new Error("Missing cleanup function.");
    pluginCleanups.push(cleanup);

    expect(getDeliveryTeamSnapshot(fake.context)?.setupWarnings).toContain(
      "gate.registration: hooks unavailable",
    );
    expect(fake.state.tools.size).toBeGreaterThan(0);
  });
});

describe("gate tracing and resolution", () => {
  test("always traces tool.before and never lets trace failures escape", async () => {
    const harness = await createGateHarness();
    const handler = createGateHandler(harness.runtime);

    expect(() => handler(event("read", { path: "src/a.ts" }))).not.toThrow();
    expect(events(harness, "tool.before")[0]).toMatchObject({
      tool: "read",
      message_id: "message-1",
      input_keys: ["path"],
    });
    expect(events(harness, "gate.unresolved")[0]).toMatchObject({ strict: false });

    harness.db.close();
    expect(() => createGateHandler(harness.runtime)(event("read", { path: "x" }))).not.toThrow();
    expect(harness.runtime.trace.getErrors().length).toBeGreaterThan(0);
  });

  test("allows unresolved calls unless gating.strict is true", async () => {
    const lenient = await createGateHarness();
    expect(() => createGateHandler(lenient.runtime)(event("write", { path: "src/a.ts" }))).not.toThrow();
    expect(events(lenient, "gate.unresolved")[0]).toMatchObject({ strict: false });

    const strict = await createGateHarness({ gating: { strict: true } });
    const error = denial(() => createGateHandler(strict.runtime)(event("write", { path: "src/a.ts" })));
    expect(error.code).toBe("unresolved_run");
    expect(error.message).toContain("Call team_start first");
    expect(events(strict, "gate.unresolved")[0]).toMatchObject({ strict: true });
  });

  test("treats multiple open runs as unresolved", async () => {
    const harness = await createGateHarness({ gating: { strict: true } });
    for (const id of ["run-a", "run-b"]) {
      harness.runs.createRun({
        id,
        title: id,
        sessionId: `session-${id}`,
        projectDir: harness.projectDir,
        phase: "brainstorm",
      });
    }
    const handler = createGateHandler(harness.runtime);
    const error = denial(() => handler(event("write", { path: "src/a.ts" }, { sessionID: "unknown" })));
    expect(error.code).toBe("unresolved_run");
    expect(error.message).toContain("Multiple open runs");
  });

  test("traces unexpected gate errors and allows the call", async () => {
    const harness = await createGateHarness();
    const broken = {
      ...harness.runtime,
      config: {
        ...harness.runtime.config,
        gating: { ...harness.runtime.config.gating, editTools: null },
      },
    } as unknown as ToolRuntime;

    expect(() => createGateHandler(broken)(event("read", { path: "src/a.ts" }))).not.toThrow();
    const traced = events(harness, "gate.error")[0];
    expect(traced).toMatchObject({ tool: "read" });
    expect(String(traced?.message)).toContain("includes");
  });
});

describe("edit phase gate", () => {
  test("blocks source edits before implement and always allows the run root", async () => {
    const harness = await createGateHarness();
    const run = startRun(harness);
    const handler = createGateHandler(harness.runtime);

    const edit = denial(() => handler(event("edit", { path: "src/app.ts" })));
    expect(edit.code).toBe("edit_phase_blocked");
    expect(edit.message).toContain("during 'brainstorm'");
    expect(edit.message).toContain("team_advance");

    expect(denial(() => handler(event("write", { path: "README.md" }))).code).toBe("edit_phase_blocked");
    expect(() => handler(event("write", { path: path.join(harness.rootDir, "runs", run.id, "spec.md") }))).not.toThrow();
    expect(() => handler(event("edit", { path: ".team/runs/run-one/plan.md" }))).not.toThrow();

    harness.runs.updatePhase(run.id, "implement");
    expect(() => handler(event("edit", { path: "src/app.ts" }))).not.toThrow();
    expect(() => handler(event("write", { path: "README.md" }))).not.toThrow();
  });

  test("checks every path in a multi-file patch including move destinations", async () => {
    const harness = await createGateHarness();
    const run = startRun(harness);
    const handler = createGateHandler(harness.runtime);

    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+new",
      "*** End Patch",
    ].join("\n");
    const multi = denial(() => handler(event("patch", { patchText: patch })));
    expect(multi.code).toBe("edit_phase_blocked");
    expect(multi.message).toContain("src/a.ts");

    const move = [
      "*** Begin Patch",
      `*** Update File: .team/runs/${run.id}/spec.md`,
      "@@",
      "-old",
      "+new",
      "*** Move to: src/moved.md",
      "*** End Patch",
    ].join("\n");
    const moved = denial(() => handler(event("patch", { patchText: move })));
    expect(moved.code).toBe("edit_phase_blocked");
    expect(moved.message).toContain("src/moved.md");

    const rootOnly = [
      "*** Begin Patch",
      `*** Update File: .team/runs/${run.id}/spec.md`,
      "@@",
      "-old",
      "+new",
      `*** Add File: .team/runs/${run.id}/plan.md`,
      "+plan",
      "*** End Patch",
    ].join("\n");
    expect(() => handler(event("patch", { patchText: rootOnly }))).not.toThrow();
  });

  test("denies unknown path shapes conservatively and honors configurable extractors", async () => {
    const defaults = await createGateHarness();
    startRun(defaults);
    const defaultHandler = createGateHandler(defaults.runtime);

    expect(denial(() => defaultHandler(event("write", { content: "no path" }))).code).toBe("edit_path_unknown");
    expect(denial(() => defaultHandler(event("patch", { patchText: "not a patch" }))).code).toBe("edit_path_unknown");

    const custom = await createGateHarness({
      gating: { editTools: ["apply"], pathKeys: { apply: "target" } },
    });
    const run = startRun(custom);
    const customHandler = createGateHandler(custom.runtime);

    expect(denial(() => customHandler(event("apply", { target: "" }))).code).toBe("edit_path_unknown");
    expect(denial(() => customHandler(event("apply", { target: "src/x.ts" }))).code).toBe("edit_phase_blocked");

    custom.runs.updatePhase(run.id, "implement");
    expect(() => customHandler(event("apply", { target: "src/x.ts" }))).not.toThrow();
    // Tools outside the configured edit set are not gated.
    expect(() => customHandler(event("write", { content: "no path" }))).not.toThrow();

    const unconfigured = await createGateHarness({ gating: { editTools: ["apply"] } });
    startRun(unconfigured);
    // A custom edit tool without a path key is denied rather than guessed.
    expect(denial(() => createGateHandler(unconfigured.runtime)(
      event("apply", { path: "src/x.ts" }),
    )).code).toBe("edit_path_unknown");
  });
});

describe("role scope gate", () => {
  test("restricts tester edits to test globs and always allows the run root", async () => {
    const harness = await createGateHarness();
    const run = startRun(harness, "test");
    setProfile(harness, run, ["spec/**"], ["manual/**"]);
    const handler = createGateHandler(harness.runtime);

    expect(() => handler(event("write", { path: "spec/sample_spec.ts" }, { agent: "tester" }))).not.toThrow();
    expect(() => handler(event("write", { path: ".team/notes.md" }, { agent: "tester" }))).not.toThrow();

    const error = denial(() => handler(event("write", { path: "src/app.ts" }, { agent: "tester" })));
    expect(error.code).toBe("scope_tests");
    expect(error.message).toContain("spec/**");
  });

  test("falls back to cross-language test globs and traces gate.scope_default once", async () => {
    const harness = await createGateHarness();
    const run = startRun(harness, "test");
    setProfile(harness, run, [], []);
    const handler = createGateHandler(harness.runtime);

    expect(() => handler(event("write", { path: "tests/app.test.ts" }, { agent: "tester" }))).not.toThrow();
    expect(denial(() => handler(event("write", { path: "src/app.ts" }, { agent: "tester" }))).code).toBe("scope_tests");
    expect(() => handler(event("write", { path: "src/other.test.ts" }, { agent: "tester" }))).not.toThrow();

    const traced = events(harness, "gate.scope_default", run.id);
    expect(traced).toHaveLength(1);
    expect(traced[0]).toMatchObject({ scope: "tests", profile_source: "researcher" });
    expect(traced[0]?.tests).toContain("**/*.test.*");
  });

  test("restricts docs edits to documentation globs and falls back to docs defaults", async () => {
    const harness = await createGateHarness();
    const run = startRun(harness, "docs");
    setProfile(harness, run, ["spec/**"], ["manual/**"]);
    const handler = createGateHandler(harness.runtime);

    expect(() => handler(event("write", { path: "manual/guide.md" }, { agent: "docs" }))).not.toThrow();
    expect(() => handler(event("write", { path: ".team/notes.md" }, { agent: "docs" }))).not.toThrow();
    expect(denial(() => handler(event("write", { path: "src/app.ts" }, { agent: "docs" }))).code).toBe("scope_docs");

    setProfile(harness, run, [], []);
    expect(() => handler(event("write", { path: "docs/guide.md" }, { agent: "docs" }))).not.toThrow();
    const traced = events(harness, "gate.scope_default", run.id);
    expect(traced[0]).toMatchObject({ scope: "docs" });
  });

  test("restricts spec and retro to the run root", async () => {
    const harness = await createGateHarness();
    // Use a post-implement phase so the edit-phase gate does not fire first.
    const run = startRun(harness, "test");
    const handler = createGateHandler(harness.runtime);

    expect(() => handler(event("write", { path: `.team/runs/${run.id}/spec.md` }, { agent: "spec" }))).not.toThrow();
    expect(denial(() => handler(event("write", { path: "README.md" }, { agent: "spec" }))).code).toBe("scope_root");

    harness.runs.updatePhase(run.id, "retro");
    expect(denial(() => handler(event("write", { path: "docs/guide.md" }, { agent: "retro" }))).code).toBe("scope_root");
  });

  test("denies scoped edits outside the project", async () => {
    const harness = await createGateHarness();
    const run = startRun(harness, "test");
    setProfile(harness, run, ["spec/**"], ["manual/**"]);
    const handler = createGateHandler(harness.runtime);

    const relative = denial(() => handler(event(
      "write",
      { path: "../elsewhere/app.test.ts" },
      { agent: "tester" },
    )));
    expect(relative.code).toBe("scope_outside_project");

    const absolute = denial(() => handler(event(
      "write",
      { path: path.join(os.tmpdir(), "outside.test.ts") },
      { agent: "tester" },
    )));
    expect(absolute.code).toBe("scope_outside_project");
  });

  test("skips scope checks without a known agent but still enforces the phase gate", async () => {
    const harness = await createGateHarness();
    const run = startRun(harness, "test");
    setProfile(harness, run, ["spec/**"], ["manual/**"]);
    const handler = createGateHandler(harness.runtime);

    expect(() => handler(event("write", { path: "src/app.ts" }, { agent: "unknown-agent" }))).not.toThrow();
    expect(() => handler(event("write", { path: "src/lib.ts" }, { agent: "unknown-agent" }))).not.toThrow();
    expect(() => handler(event("write", { path: "src/lead.ts" }, { agent: "team-lead" }))).not.toThrow();
    expect(events(harness, "gate.scope_skipped", run.id)).toHaveLength(1);

    harness.runs.updatePhase(run.id, "brainstorm");
    expect(denial(() => handler(event("write", { path: "src/app.ts" }, { agent: "" }))).code).toBe("edit_phase_blocked");
    expect(events(harness, "gate.scope_skipped", run.id)).toHaveLength(1);
  });
});

describe("CLI approval bypass", () => {
  test("blocks direct lesson and prompt approvals in shell commands", async () => {
    const harness = await createGateHarness();
    const handler = createGateHandler(harness.runtime);

    const lessons = denial(() => handler(event("shell", {
      command: "team lessons approve --role developer",
    })));
    expect(lessons.code).toBe("cli_approval_blocked");
    expect(lessons.message).toContain("team lessons approve");

    const prompts = denial(() => handler(event("bash", {
      command: "echo ok && team   prompts\napprove docs",
    })));
    expect(prompts.code).toBe("cli_approval_blocked");
    expect(prompts.message).toContain("team prompts approve");

    expect(() => handler(event("shell", { command: "bun test" }))).not.toThrow();
  });
});

describe("gate integration through the plugin", () => {
  test("blocks and allows edits through the registered execute.before hook", async () => {
    const { fake } = await setupPlugin();
    const started = await fake.invokeTool(
      "team_start",
      { title: "Gate integration" },
      { sessionID: "session-1", agent: "team-lead", id: "call-start" },
    );
    const run = (started.output as { run?: string } | undefined)?.run;
    if (!run) throw new Error("team_start did not return a run id.");

    const blocked = await asyncDenial(() => fake.invokeToolBefore({
      tool: "write",
      input: { path: "src/app.ts" },
      agent: "developer",
    }));
    expect(blocked.code).toBe("edit_phase_blocked");

    await fake.invokeToolBefore({
      tool: "write",
      input: { path: path.join(".team", "runs", run, "spec.md") },
      agent: "developer",
    });

    const shell = await asyncDenial(() => fake.invokeToolBefore({
      tool: "shell",
      input: { command: "team lessons approve --role developer" },
      agent: "developer",
    }));
    expect(shell.code).toBe("cli_approval_blocked");

    const { db } = await openDatabase(path.join(fake.context.location.directory, ".team", "team.db"));
    try {
      const denied = db.get<{ data_json: string }>(
        "SELECT data_json FROM events WHERE run_id = ? AND kind = 'gate.denied' ORDER BY id LIMIT 1",
        [run],
      );
      expect(JSON.parse(denied?.data_json ?? "{}")).toMatchObject({
        tool: "write",
        code: "edit_phase_blocked",
      });
      const before = db.get<{ data_json: string }>(
        "SELECT data_json FROM events WHERE kind = 'tool.before' AND data_json LIKE '%\"tool\":\"write\"%' LIMIT 1",
      );
      expect(JSON.parse(before?.data_json ?? "{}")).toMatchObject({
        tool: "write",
        message_id: "message-1",
      });
    } finally {
      db.close();
    }
  });
});
