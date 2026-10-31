import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig, type DeliveryTeamConfig } from "../../src/config";
import {
  createTraceAfterHandler,
  createTraceBeforeHandler,
  TraceSpans,
  type ToolAfterEvent,
  type ToolBeforeEvent,
} from "../../src/hooks/trace";
import { openDatabase, type TeamDatabase } from "../../src/state/db";
import { LessonsRepository } from "../../src/state/lessons";
import { redactText } from "../../src/state/privacy";
import { RunRepository, type ToolCallRow } from "../../src/state/runs";
import { Tracer } from "../../src/state/trace";
import type { ToolRuntime } from "../../src/tools/runtime";

interface TraceHarness {
  readonly projectDir: string;
  readonly db: TeamDatabase;
  readonly runs: RunRepository;
  readonly runtime: ToolRuntime;
  readonly config: DeliveryTeamConfig;
}

const directories: string[] = [];
const databases: TeamDatabase[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      // Deliberately closed databases are fine.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function harness(options: unknown = {}): Promise<TraceHarness> {
  const projectDir = mkdtempSync(path.join(os.tmpdir(), "delivery-team-trace-"));
  directories.push(projectDir);
  const config = parseConfig(options, projectDir);
  const opened = await openDatabase(config.dbPath);
  databases.push(opened.db);
  const runs = new RunRepository(opened.db);
  const runtime: ToolRuntime = {
    config,
    db: opened.db,
    trace: new Tracer(opened.db, undefined, () => {}),
    runs,
    lessons: new LessonsRepository(opened.db),
    modelSnapshot: { roles: {}, events: [] },
  };
  const run = runs.createRun({
    id: "run-trace",
    title: "Trace",
    sessionId: "session-1",
    projectDir,
    phase: "brainstorm",
  });
  runs.bindSession("session-1", run.id, "team-lead");
  return { projectDir, db: opened.db, runs, runtime, config };
}

function before(overrides: Partial<ToolBeforeEvent> = {}): ToolBeforeEvent {
  return {
    tool: "read",
    sessionID: "session-1",
    agent: "team-lead",
    messageID: "message-1",
    id: "call-1",
    input: { path: "src/a.ts" },
    ...overrides,
  };
}

function completed(overrides: Partial<ToolBeforeEvent> = {}, result: unknown = {
  output: { ok: true },
  content: [{ type: "text", text: "ok" }],
}): ToolAfterEvent {
  return { ...before(overrides), status: "completed", result };
}

function failed(overrides: Partial<ToolBeforeEvent> = {}, message = "boom"): ToolAfterEvent {
  return { ...before(overrides), status: "error", error: { message } };
}

function rows(db: TeamDatabase): ToolCallRow[] {
  return db.all<ToolCallRow>("SELECT * FROM tool_calls ORDER BY id");
}

describe("tool call tracing", () => {
  test("correlates before and after, records timing, and keeps privacy defaults off", async () => {
    const h = await harness();
    const spans = new TraceSpans();
    let now = 1_000;
    const traceBefore = createTraceBeforeHandler(h.runtime, spans, { now: () => now });
    const traceAfter = createTraceAfterHandler(h.runtime, spans, { now: () => now });

    traceBefore(before());
    now = 1_012;
    traceAfter(completed());

    const calls = rows(h.db);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      run_id: "run-trace",
      session_id: "session-1",
      agent: "team-lead",
      tool_call_id: "call-1",
      tool: "read",
      phase: "brainstorm",
      duration_ms: 12,
      ok: 1,
      input_json: null,
      output_preview: null,
    });
    expect(calls[0]?.output_bytes).toBeGreaterThan(0);
    expect(calls[0]?.started_at).toBe(new Date(1_000).toISOString());
    expect(spans.size()).toBe(0);

    const event = h.db.get<{ run_id: string; data_json: string }>(
      "SELECT run_id, data_json FROM events WHERE kind = 'tool.before'",
    );
    expect(event?.run_id).toBe("run-trace");
    expect(JSON.parse(event?.data_json ?? "{}")).toMatchObject({
      tool: "read",
      message_id: "message-1",
      input_keys: ["path"],
    });
  });

  test("redacts secrets and truncates previews when capture is enabled", async () => {
    const h = await harness({ trace: { captureInput: true, previewChars: 24 } });
    const spans = new TraceSpans();
    const traceBefore = createTraceBeforeHandler(h.runtime, spans);
    const traceAfter = createTraceAfterHandler(h.runtime, spans);

    traceBefore(before({
      input: {
        path: "src/a.ts",
        password: "hunter2",
        nested: { apiKey: "plain-secret-value", accessToken: "abc" },
      },
    }));
    traceAfter(completed({
      input: {
        path: "src/a.ts",
        password: "hunter2",
        nested: { apiKey: "plain-secret-value", accessToken: "abc" },
      },
    }, {
      output: {
        ok: true,
        token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        message: "Authorization: Bearer supersecret",
      },
    }));

    const row = rows(h.db)[0];
    const input = JSON.parse(row?.input_json ?? "{}");
    expect(input).toMatchObject({
      path: "src/a.ts",
      password: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", accessToken: "[REDACTED]" },
    });
    expect(String(row?.output_preview).length).toBeLessThanOrEqual(24);
    expect(row?.output_preview).not.toContain("ghp_");
    expect(row?.output_preview).not.toContain("supersecret");
    expect(row?.output_bytes).toBeGreaterThan(0);
  });

  test("redacts secret-key values in structured previews and serialized JSON exports", async () => {
    const h = await harness({ trace: { previewChars: 500 } });
    const spans = new TraceSpans();
    const traceBefore = createTraceBeforeHandler(h.runtime, spans);
    const traceAfter = createTraceAfterHandler(h.runtime, spans);

    traceBefore(before());
    traceAfter(completed({}, {
      output: {
        password: "hunter2",
        apiKey: "plain-secret-value",
        nested: { accessToken: "nested-secret-value" },
      },
    }));

    const preview = rows(h.db)[0]?.output_preview ?? "";
    expect(JSON.parse(preview)).toEqual({
      password: "[REDACTED]",
      apiKey: "[REDACTED]",
      nested: { accessToken: "[REDACTED]" },
    });
    expect(preview).not.toContain("hunter2");
    expect(preview).not.toContain("plain-secret-value");
    expect(preview).not.toContain("nested-secret-value");

    const existingJsonPreview = redactText('{"password":"hunter2","apiKey":"plain-secret-value"}');
    expect(JSON.parse(existingJsonPreview)).toEqual({
      password: "[REDACTED]",
      apiKey: "[REDACTED]",
    });
  });

  test("records failures, expected tool failures, and a missing before span", async () => {
    const h = await harness({ trace: { previewChars: 100 } });
    const spans = new TraceSpans();
    const traceAfter = createTraceAfterHandler(h.runtime, spans);

    traceAfter(failed({ id: "call-error" }, "boom sk-abcdefghijklmnopqrstuvwxyz"));
    traceAfter(completed({ id: "call-expected" }, { output: { ok: false, error: "denied" } }));

    const calls = rows(h.db);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ tool_call_id: "call-error", ok: 0, duration_ms: null });
    expect(calls[0]?.output_preview).toContain("boom");
    expect(calls[0]?.output_preview).not.toContain("sk-");
    expect(calls[1]).toMatchObject({ tool_call_id: "call-expected", ok: 0, duration_ms: null });
    expect(calls[1]?.run_id).toBe("run-trace");
  });

  test("keeps a LIFO stack when nested calls share a call ID", async () => {
    const h = await harness();
    const spans = new TraceSpans();
    let now = 100;
    const traceBefore = createTraceBeforeHandler(h.runtime, spans, { now: () => now });
    const traceAfter = createTraceAfterHandler(h.runtime, spans, { now: () => now });

    traceBefore(before({ tool: "execute", id: "shared" }));
    now = 105;
    traceBefore(before({ tool: "team_status", id: "shared" }));
    now = 110;
    traceAfter(completed({ tool: "team_status", id: "shared" }));
    now = 130;
    traceAfter(completed({ tool: "execute", id: "shared" }));

    const calls = rows(h.db);
    expect(calls).toHaveLength(2);
    const outer = calls.find((row) => row.tool === "execute");
    const nested = calls.find((row) => row.tool === "team_status");
    expect(outer).toMatchObject({ tool: "execute", duration_ms: 30 });
    expect(nested).toMatchObject({ tool: "team_status", duration_ms: 5 });
    expect(spans.size()).toBe(0);
  });

  test("never throws when the database is broken", async () => {
    const h = await harness();
    const spans = new TraceSpans();
    const traceBefore = createTraceBeforeHandler(h.runtime, spans);
    const traceAfter = createTraceAfterHandler(h.runtime, spans);
    h.db.close();

    expect(() => traceBefore(before())).not.toThrow();
    expect(() => traceAfter(completed())).not.toThrow();
    expect(h.runtime.trace.getErrors().length).toBeGreaterThan(0);
  });

  test("redacts trace event, input, and preview values at the persistence boundary", async () => {
    const h = await harness();
    h.runtime.trace.event("privacy.test", {
      apiKey: "plain-secret-value",
      detail: '{"password":"hunter2"}',
    });
    h.runtime.trace.toolCall({
      tool: "read",
      input: { accessToken: "nested-secret-value" },
      outputPreview: '{"password":"hunter2"}',
    });

    const event = h.db.get<{ data_json: string }>(
      "SELECT data_json FROM events WHERE kind = 'privacy.test'",
    );
    const call = h.db.get<{ input_json: string; output_preview: string }>(
      "SELECT input_json, output_preview FROM tool_calls ORDER BY id DESC LIMIT 1",
    );
    expect(JSON.parse(event?.data_json ?? "{}")).toEqual({
      apiKey: "[REDACTED]",
      detail: '{"password":"[REDACTED]"}',
    });
    expect(JSON.parse(call?.input_json ?? "{}")).toEqual({ accessToken: "[REDACTED]" });
    expect(JSON.parse(call?.output_preview ?? "{}")).toEqual({ password: "[REDACTED]" });
  });
});
