import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  renderRunReport,
  writeRunReport,
  type ReportInput,
} from "../../src/state/report";
import type {
  MessageRow,
  PhaseTransitionRow,
  RunRow,
  SessionRow,
  ToolCallRow,
} from "../../src/state/runs";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const run: RunRow = {
  id: "run-report",
  title: "Report",
  description: "A full report",
  status: "closed",
  phase: "done",
  lead_session_id: "session-1",
  project_dir: "/project",
  stack_json: null,
  created_at: "2026-01-01T09:00:00.000Z",
  closed_at: "2026-01-01T10:10:00.000Z",
};

const transitions: PhaseTransitionRow[] = [
  {
    id: 1,
    run_id: run.id,
    from_phase: null,
    to_phase: "brainstorm",
    kind: "start",
    reason: null,
    at: "2026-01-01T10:00:00.000Z",
  },
  {
    id: 2,
    run_id: run.id,
    from_phase: "brainstorm",
    to_phase: "spec",
    kind: "advance",
    reason: null,
    at: "2026-01-01T10:02:00.000Z",
  },
];

const toolCalls: ToolCallRow[] = [
  {
    id: 1,
    run_id: run.id,
    session_id: "session-1",
    agent: "developer",
    tool_call_id: "call-1",
    tool: "write",
    phase: "implement",
    started_at: "2026-01-01T10:03:00.000Z",
    duration_ms: 20,
    ok: 1,
    output_bytes: 10,
    input_json: null,
    output_preview: null,
  },
  {
    id: 2,
    run_id: run.id,
    session_id: "session-1",
    agent: "developer",
    tool_call_id: "call-2",
    tool: "shell",
    phase: "test",
    started_at: "2026-01-01T10:04:00.000Z",
    duration_ms: 30,
    ok: 0,
    output_bytes: 5,
    input_json: null,
    output_preview: null,
  },
  {
    id: 3,
    run_id: run.id,
    session_id: "session-2",
    agent: "tester",
    tool_call_id: "call-3",
    tool: "write",
    phase: "test",
    started_at: "2026-01-01T10:05:00.000Z",
    duration_ms: 10,
    ok: 1,
    output_bytes: 7,
    input_json: null,
    output_preview: null,
  },
];

const messages: MessageRow[] = [
  {
    id: "message-1",
    session_id: "session-1",
    run_id: run.id,
    agent: "developer",
    model: "provider/model-a",
    tokens_in: 100,
    tokens_out: 50,
    cost: 0.01,
    at: "2026-01-01T10:03:00.000Z",
  },
  {
    id: "message-2",
    session_id: "session-2",
    run_id: run.id,
    agent: "tester",
    model: "provider/model-b",
    tokens_in: 20,
    tokens_out: 10,
    cost: 0.002,
    at: "2026-01-01T10:06:00.000Z",
  },
];

const sessions: SessionRow[] = [
  {
    id: "session-1",
    parent_id: null,
    run_id: run.id,
    agent: "team-lead",
    started_at: "2026-01-01T10:00:00.000Z",
    ended_at: null,
  },
  {
    id: "session-2",
    parent_id: "session-1",
    run_id: run.id,
    agent: "tester",
    started_at: "2026-01-01T10:05:00.000Z",
    ended_at: "2026-01-01T10:07:00.000Z",
  },
];

function input(): ReportInput {
  return {
    run,
    transitions,
    loops: [{ phase: "test", count: 2 }],
    notes: [{
      id: 1,
      run_id: run.id,
      kind: "decision",
      text: "approved",
      agent: "team-lead",
      session_id: "session-1",
      at: "2026-01-01T10:01:00.000Z",
    }],
    events: [
      {
        kind: "gate.denied",
        at: "2026-01-01T10:02:00.000Z",
        data_json: JSON.stringify({ phase: "spec", code: "missing_approval_note", message: "denied" }),
      },
      {
        kind: "gate.unresolved",
        at: "2026-01-01T10:02:30.000Z",
        data_json: JSON.stringify({ message: "no run" }),
      },
    ],
    toolCalls,
    messages,
    sessions,
    now: "2026-01-01T11:00:00.000Z",
  };
}

describe("run report", () => {
  test("renders durations, tool counts, messages, sessions, loops, and gate denials", () => {
    const report = renderRunReport(input());

    expect(report).toContain("# Delivery run run-report: Report");
    expect(report).toContain("- Closed: 2026-01-01T10:10:00.000Z");
    expect(report).toContain("| brainstorm | 2026-01-01T10:00:00.000Z | 2.0 min |");
    expect(report).toContain("| spec | 2026-01-01T10:02:00.000Z | 8.0 min |");
    expect(report).toContain("3 calls, 1 failed, 60 ms total, 22 output bytes.");
    expect(report).toContain("| shell | 1 | 1 | 30 ms | 5 |");
    expect(report).toContain("| tester | 1 | 0 |");
    expect(report).toContain("### Failed tool calls");
    expect(report).toContain("2 messages, 120 input tokens, 60 output tokens, $0.012000 total cost.");
    expect(report).toContain("| developer | provider/model-a | 1 | 100 | 50 | $0.010000 |");
    expect(report).toContain("| session-2 | session-1 | tester |");
    expect(report).toContain("- test: 2");
    expect(report).toContain("Unresolved gate evaluations: 1.");
    expect(report).toContain("[missing_approval_note] denied");
    expect(report).toContain("- 2026-01-01T10:01:00.000Z [decision] approved");
  });

  test("renders role-qualified loops and a review wave section only for wave events", () => {
    const sequential = renderRunReport(input());
    expect(sequential).toContain("- test: 2");
    expect(sequential).not.toContain("## Review wave");

    const report = renderRunReport({
      ...input(),
      loops: [
        { phase: "test", role: "", count: 2 },
        { phase: "qa", role: "adversary", count: 1 },
        { phase: "qa", role: "qa", count: 2 },
      ],
      events: [
        ...input().events,
        {
          kind: "review.wave.started",
          at: "2026-01-01T10:08:00.000Z",
          data_json: JSON.stringify({
            phase: "qa",
            members: ["qa", "adversary"],
            cause: "advance",
            generation: 1,
            max_loops: 3,
          }),
        },
        {
          kind: "review.wave.denied",
          at: "2026-01-01T10:09:00.000Z",
          data_json: JSON.stringify({
            phase: "qa",
            gate_code: "verdict_not_pass",
            failing_members: [{ role: "qa", artifact: "qa.md", code: "verdict_not_pass" }],
            ready: false,
            generation: 1,
          }),
        },
        {
          kind: "review.wave.completed",
          at: "2026-01-01T10:10:00.000Z",
          data_json: JSON.stringify({
            phase: "qa",
            to: "docs",
            skipped: "adversary",
            duration_ms: 1500,
            generation: 1,
            members: [{ role: "qa" }, { role: "adversary" }],
          }),
        },
      ],
    });

    expect(report).toContain("- test: 2");
    expect(report).toContain("- qa [qa]: 2");
    expect(report).toContain("- qa [adversary]: 1");
    expect(report).not.toContain("- test [");
    expect(report).toContain("## Review wave");
    expect(report).toContain("started (advance): generation 1; members qa, adversary.");
    expect(report).toContain("denied (verdict_not_pass): generation 1; failing qa (qa.md).");
    expect(report).toContain("completed: generation 1; qa, adversary -> docs (skipped adversary); duration 1.5 s.");
    expect(report.indexOf("## Review wave")).toBeGreaterThan(report.indexOf("## Loops"));
    expect(report.indexOf("## Review wave")).toBeLessThan(report.indexOf("## Gate denials"));
  });

  test("writes report.md under the run directory", () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "delivery-team-report-"));
    directories.push(rootDir);
    const reportPath = writeRunReport(rootDir, input());
    expect(reportPath).toBe(path.join(rootDir, "runs", run.id, "report.md"));
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toContain("## Tool calls");
  });

  test("handles an empty run without throwing", () => {
    const report = renderRunReport({
      run: { ...run, description: null, closed_at: null, status: "open", phase: "brainstorm" },
      transitions: [],
      loops: [],
      notes: [],
      events: [],
      now: "2026-01-01T10:00:00.000Z",
    });
    expect(report).toContain("_No transitions recorded._");
    expect(report).toContain("_No tool calls recorded._");
    expect(report).toContain("_No messages recorded.");
    expect(report).toContain("_No sessions recorded._");
    expect(report).toContain("_No gate denials._");
  });
});
