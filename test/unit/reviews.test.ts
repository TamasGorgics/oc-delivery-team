import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../../src/state/db";
import { nextPhase, PHASES, type Phase } from "../../src/state/phases";
import {
  REVIEW_MEMBERS,
  evaluateReviewBarrier,
  reviewAdvanceTarget,
  reviewArtifactPaths,
  reviewWaveStatus,
  serializeGateResult,
  serializeReviewWave,
} from "../../src/state/reviews";
import { RunRepository, type PhaseTransitionRow, type RunStatus } from "../../src/state/runs";
import { parseStackProfile, type StackProfile } from "../../src/stack/profile";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const profile = parseStackProfile({ components: [] }).profile as StackProfile;
const RUN = "run-review";

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "delivery-team-reviews-"));
  directories.push(root);
  return root;
}

function tempDb(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-reviews-db-"));
  directories.push(directory);
  return path.join(directory, "team.db");
}

function footer(lines: readonly string[], trailing = "\n"): string {
  return `# Artifact\n\n<!-- team-footer -->\n${lines.join("\n")}\n<!-- /team-footer -->${trailing}`;
}

function writeArtifact(root: string, artifact: string, contents: string, run = RUN): string {
  const directory = path.join(root, "runs", run);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, artifact);
  writeFileSync(file, contents, "utf8");
  return file;
}

function transition(
  id: number,
  to: Phase,
  at: string,
  kind: "advance" | "rewind" | "start" = "advance",
  from: Phase | null = null,
): PhaseTransitionRow {
  return {
    id,
    run_id: RUN,
    from_phase: from,
    to_phase: to,
    kind,
    reason: null,
    at,
  };
}

function wave(
  root: string,
  options: {
    readonly enabled?: boolean;
    readonly phase?: Phase;
    readonly status?: RunStatus;
    readonly transitions?: readonly PhaseTransitionRow[];
  } = {},
) {
  return reviewWaveStatus({
    enabled: options.enabled ?? true,
    run: { id: RUN, phase: options.phase ?? "qa", status: options.status ?? "open" },
    rootDir: root,
    profile,
    notes: [],
    transitions: options.transitions ?? [],
  });
}

function barrier(root: string) {
  return evaluateReviewBarrier({
    rootDir: root,
    runId: RUN,
    profile,
    notes: [],
  });
}

describe("review barrier", () => {
  test("evaluates both members in fixed qa-then-adversary order and aggregates every failure", () => {
    const root = tempRoot();
    let result = barrier(root);

    expect(result.ok).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.code).toBe("missing_artifact");
    expect(result.artifact).toBe("qa.md");
    expect(result.artifactPath).toBe(path.join(root, "runs", RUN, "qa.md"));
    expect(result.members.map((member) => member.role)).toEqual(["qa", "adversary"]);
    expect(result.members.map((member) => member.code)).toEqual(["missing_artifact", "missing_artifact"]);
    expect(result.message).toContain("qa (qa.md)");
    expect(result.message).toContain("adversary (adversary.md)");

    writeArtifact(root, "qa.md", footer(["VERDICT: PASS"]));
    result = barrier(root);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("missing_artifact");
    expect(result.artifact).toBe("adversary.md");
    expect(result.members.map((member) => member.code)).toEqual(["ok", "missing_artifact"]);
    expect(result.message).toContain("adversary (adversary.md)");
    expect(result.message).not.toContain("qa (qa.md)");

    writeArtifact(root, "qa.md", footer(["VERDICT: FAIL"]));
    writeArtifact(root, "adversary.md", footer(["BLOCKERS: 2"]));
    result = barrier(root);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("verdict_not_pass");
    expect(result.artifact).toBe("qa.md");
    expect(result.footer?.values).toEqual({ VERDICT: "FAIL" });
    expect(result.members.map((member) => member.code)).toEqual(["verdict_not_pass", "blockers"]);
    expect(result.message).toContain("qa (qa.md)");
    expect(result.message).toContain("adversary (adversary.md)");

    writeArtifact(root, "qa.md", footer(["VERDICT: PASS"]));
    writeArtifact(root, "adversary.md", footer(["BLOCKERS: 0"]));
    result = barrier(root);
    expect(result.ok).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.code).toBe("ok");
    expect(result.members.map((member) => member.ok)).toEqual([true, true]);
    expect(result.members.map((member) => member.footer?.values)).toEqual([
      { VERDICT: "PASS" },
      { BLOCKERS: "0" },
    ]);
  });

  test("propagates member gate codes for missing, invalid, and non-final footers", () => {
    const root = tempRoot();

    writeArtifact(root, "qa.md", "# QA without a footer\n");
    let result = barrier(root);
    expect(result.members[0]?.code).toBe("missing_footer");
    expect(result.members[1]?.code).toBe("missing_artifact");
    expect(result.code).toBe("missing_footer");

    writeArtifact(root, "qa.md", footer(["VERDICT: PASS", "not a footer line"]));
    result = barrier(root);
    expect(result.members[0]?.code).toBe("invalid_footer");

    writeArtifact(root, "qa.md", footer(["VERDICT: PASS"], "\ntrailing prose\n"));
    result = barrier(root);
    expect(result.members[0]?.code).toBe("footer_not_at_end");

    writeArtifact(root, "qa.md", footer(["VERDICT: FAIL"]));
    result = barrier(root);
    expect(result.members[0]?.code).toBe("verdict_not_pass");

    writeArtifact(root, "qa.md", footer(["VERDICT: PASS"]));
    writeArtifact(root, "adversary.md", footer(["BLOCKERS: many"]));
    result = barrier(root);
    expect(result.members[1]?.code).toBe("invalid_footer");
    expect(result.code).toBe("invalid_footer");
    expect(result.artifact).toBe("adversary.md");

    writeArtifact(root, "adversary.md", footer(["BLOCKERS: 2"]));
    result = barrier(root);
    expect(result.members[1]?.code).toBe("blockers");
    expect(result.code).toBe("blockers");
    expect(result.artifact).toBe("adversary.md");
  });

  test("still evaluates adversary when qa.md is absent", () => {
    const root = tempRoot();
    writeArtifact(root, "adversary.md", footer(["BLOCKERS: 0"]));

    const result = barrier(root);
    expect(result.members.map((member) => member.role)).toEqual(["qa", "adversary"]);
    expect(result.members.map((member) => member.code)).toEqual(["missing_artifact", "ok"]);
    expect(result.code).toBe("missing_artifact");
    expect(result.artifact).toBe("qa.md");
  });
});

describe("review wave status", () => {
  test("implements the disabled/enabled/active/ready truth table", () => {
    const root = tempRoot();
    const entries = [transition(1, "qa", "2026-01-01T01:00:00.000Z", "advance", "test")];
    writeArtifact(root, "qa.md", footer(["VERDICT: PASS"]));
    writeArtifact(root, "adversary.md", footer(["BLOCKERS: 0"]));

    const disabled = wave(root, { enabled: false, transitions: entries });
    expect(disabled).toEqual({
      enabled: false,
      active: false,
      ready: false,
      phase: "qa",
      members: [],
      artifacts: {},
      generation: 1,
    });
    expect(serializeReviewWave(disabled)).toEqual({
      enabled: false,
      active: false,
      ready: false,
      phase: "qa",
      members: [],
      artifacts: {},
      generation: 1,
    });

    const outsideQa = wave(root, { phase: "brainstorm" });
    expect(outsideQa).toMatchObject({
      enabled: true,
      active: false,
      ready: false,
      phase: "brainstorm",
      generation: 0,
    });
    expect(outsideQa.members.map((member) => member.role)).toEqual([...REVIEW_MEMBERS]);
    expect(outsideQa.members.map((member) => member.gate)).toEqual([null, null]);
    expect(outsideQa.artifacts).toEqual({
      qa: path.join(root, "runs", RUN, "qa.md"),
      adversary: path.join(root, "runs", RUN, "adversary.md"),
    });
    expect(serializeReviewWave(outsideQa).started_at).toBeUndefined();

    const empty = tempRoot();
    const activeNone = wave(empty, { transitions: entries });
    expect(activeNone).toMatchObject({
      enabled: true,
      active: true,
      ready: false,
      phase: "qa",
      generation: 1,
      started_at: "2026-01-01T01:00:00.000Z",
    });
    expect(activeNone.members.map((member) => member.gate?.code)).toEqual([
      "missing_artifact",
      "missing_artifact",
    ]);

    const qaOnly = tempRoot();
    writeArtifact(qaOnly, "qa.md", footer(["VERDICT: PASS"]));
    const activeQa = wave(qaOnly, { transitions: entries });
    expect(activeQa.ready).toBe(false);
    expect(activeQa.members[0]?.gate?.ok).toBe(true);
    expect(activeQa.members[1]?.gate?.code).toBe("missing_artifact");

    const adversaryOnly = tempRoot();
    writeArtifact(adversaryOnly, "adversary.md", footer(["BLOCKERS: 0"]));
    const activeAdversary = wave(adversaryOnly, { transitions: entries });
    expect(activeAdversary.ready).toBe(false);
    expect(activeAdversary.members[0]?.gate?.code).toBe("missing_artifact");
    expect(activeAdversary.members[1]?.gate?.ok).toBe(true);

    const both = wave(root, { transitions: entries });
    expect(both).toMatchObject({ enabled: true, active: true, ready: true, generation: 1 });
    expect(both.members.map((member) => member.gate?.ok)).toEqual([true, true]);

    const closed = wave(root, { status: "closed", transitions: entries });
    expect(closed).toMatchObject({ enabled: true, active: false, ready: false });
    expect(closed.members.map((member) => member.gate)).toEqual([null, null]);
  });

  test("derives generation from advance/rewind entries into qa and started_at only while active", () => {
    const root = tempRoot();
    writeArtifact(root, "qa.md", footer(["VERDICT: PASS"]));
    writeArtifact(root, "adversary.md", footer(["BLOCKERS: 0"]));
    const transitions = [
      transition(1, "brainstorm", "2026-01-01T00:00:00.000Z", "start"),
      transition(2, "spec", "2026-01-01T00:10:00.000Z", "advance", "brainstorm"),
      transition(3, "qa", "2026-01-01T01:00:00.000Z", "advance", "test"),
      transition(4, "implement", "2026-01-01T02:00:00.000Z", "rewind", "docs"),
      transition(5, "qa", "2026-01-01T03:00:00.000Z", "advance", "test"),
      transition(6, "qa", "2026-01-01T04:00:00.000Z", "start"),
    ];

    const active = wave(root, { transitions });
    expect(active.generation).toBe(2);
    expect(active.started_at).toBe("2026-01-01T03:00:00.000Z");

    const outside = wave(root, { phase: "docs", transitions });
    expect(outside.generation).toBe(2);
    expect(outside.started_at).toBeUndefined();

    const disabled = wave(root, { enabled: false, transitions });
    expect(disabled.generation).toBe(2);
    expect(disabled.started_at).toBeUndefined();

    const none = wave(root, { transitions: [] });
    expect(none.generation).toBe(0);
    expect(none.started_at).toBeUndefined();
  });

  test("serializes member gates, footers, loops, and disabled empty payloads consistently", () => {
    const root = tempRoot();
    writeArtifact(root, "qa.md", footer(["VERDICT: PASS"]));
    const entries = [transition(1, "qa", "2026-01-01T01:00:00.000Z", "advance", "test")];
    const active = reviewWaveStatus({
      enabled: true,
      run: { id: RUN, phase: "qa", status: "open" },
      rootDir: root,
      profile,
      transitions: entries,
      memberLoops: {
        qa: { count: 1, remaining: 2, escalated: false },
        adversary: { count: 0, remaining: 3, escalated: false },
      },
    });

    const serialized = serializeReviewWave(active);
    expect(serialized).toMatchObject({
      enabled: true,
      active: true,
      ready: false,
      phase: "qa",
      generation: 1,
      started_at: "2026-01-01T01:00:00.000Z",
    });
    const members = serialized.members as Array<Record<string, unknown>>;
    expect(members.map((member) => member.role)).toEqual(["qa", "adversary"]);
    expect(members[0]).toMatchObject({
      artifact: "qa.md",
      artifact_path: path.join(root, "runs", RUN, "qa.md"),
      gate: { ok: true, code: "ok", artifact_path: path.join(root, "runs", RUN, "qa.md") },
      loop: { count: 1, remaining: 2, escalated: false },
    });
    expect((members[0]?.gate as Record<string, unknown>).footer).toEqual({ VERDICT: "PASS" });
    expect(members[1]).toMatchObject({
      gate: { ok: false, code: "missing_artifact" },
      loop: { count: 0, remaining: 3, escalated: false },
    });

    const gate = serializeGateResult(barrier(root));
    expect(gate).toMatchObject({
      ok: false,
      code: "missing_artifact",
      artifact: "adversary.md",
      artifact_path: path.join(root, "runs", RUN, "adversary.md"),
      members: [
        { role: "qa", ok: true, code: "ok", artifact_path: path.join(root, "runs", RUN, "qa.md") },
        { role: "adversary", ok: false, code: "missing_artifact" },
      ],
    });
    expect(gate.artifactPath).toBeUndefined();
  });

  test("exposes both artifact paths for start/advance/rewind callers", () => {
    const root = tempRoot();
    expect(reviewArtifactPaths(root, RUN)).toEqual({
      qa: path.join(root, "runs", RUN, "qa.md"),
      adversary: path.join(root, "runs", RUN, "adversary.md"),
    });
  });
});

describe("review advance target", () => {
  test("qa -> docs only when enabled; every other phase uses nextPhase", () => {
    expect(reviewAdvanceTarget("qa", true)).toBe("docs");
    expect(reviewAdvanceTarget("qa", false)).toBe("adversary");
    for (const phase of PHASES) {
      expect(reviewAdvanceTarget(phase, false)).toBe(nextPhase(phase));
    }
    expect(reviewAdvanceTarget("test", true)).toBe("qa");
    expect(reviewAdvanceTarget("adversary", true)).toBe("docs");
    expect(reviewAdvanceTarget("docs", true)).toBe("retro");
    expect(reviewAdvanceTarget("retro", true)).toBe("done");
    expect(reviewAdvanceTarget("done", true)).toBeUndefined();
  });
});

describe("role-scoped loop repository", () => {
  test("keeps qa, adversary, and wave counters independent and ordered", async () => {
    const { db } = await openDatabase(tempDb());
    try {
      const runs = new RunRepository(db);
      runs.createRun({
        id: RUN,
        title: "Role loops",
        sessionId: "session-1",
        projectDir: "/project",
        phase: "qa",
      });

      expect(runs.getLoop(RUN, "qa")).toBe(0);
      expect(runs.getLoop(RUN, "qa", "qa")).toBe(0);
      expect(runs.incrementLoop(RUN, "qa", "qa")).toBe(1);
      expect(runs.incrementLoop(RUN, "qa", "qa")).toBe(2);
      expect(runs.incrementLoop(RUN, "qa", "adversary")).toBe(1);
      expect(runs.incrementLoop(RUN, "qa")).toBe(1);
      expect(runs.incrementLoop(RUN, "implement")).toBe(1);
      expect(runs.incrementLoop(RUN, "qa", "adversary")).toBe(2);

      expect(runs.getLoop(RUN, "qa")).toBe(1);
      expect(runs.getLoop(RUN, "qa", "qa")).toBe(2);
      expect(runs.getLoop(RUN, "qa", "adversary")).toBe(2);
      expect(runs.getLoops(RUN)).toEqual([
        { run_id: RUN, phase: "implement", role: "", count: 1 },
        { run_id: RUN, phase: "qa", role: "", count: 1 },
        { run_id: RUN, phase: "qa", role: "adversary", count: 2 },
        { run_id: RUN, phase: "qa", role: "qa", count: 2 },
      ]);
      expect(runs.getLoops(RUN, "qa")).toEqual([
        { run_id: RUN, phase: "qa", role: "qa", count: 2 },
      ]);

      runs.addTransition({ runId: RUN, from: null, to: "brainstorm", kind: "start" });
      runs.addTransition({ runId: RUN, from: "test", to: "qa", kind: "advance" });
      runs.addTransition({ runId: RUN, from: "docs", to: "qa", kind: "rewind" });
      runs.addTransition({ runId: RUN, from: null, to: "qa", kind: "start" });
      expect(runs.countPhaseEntries(RUN, "qa")).toBe(2);
    } finally {
      db.close();
    }
  });
});
