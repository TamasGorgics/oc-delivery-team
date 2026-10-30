import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PHASE_ARTIFACTS,
  artifactNameForPhase,
  needsFooter,
  parseFooter,
  parseInteger,
  validatePhaseGate,
  type GateCode,
} from "../../src/state/artifacts";
import { PHASES, type Phase } from "../../src/state/phases";
import { parseStackProfile, type StackProfile } from "../../src/stack/profile";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const noTestProfile: StackProfile = parseStackProfile({ components: [] }).profile as StackProfile;
const testCommandProfile: StackProfile = parseStackProfile({
  components: [{ name: "root", commands: { test: "bun test" } }],
}).profile as StackProfile;

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "delivery-team-gate-"));
  roots.push(root);
  return root;
}

function writeArtifact(root: string, run: string, artifact: string, contents: string): void {
  const directory = path.join(root, "runs", run);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, artifact), contents, "utf8");
}

function footer(lines: readonly string[], trailing = "\n"): string {
  return `# Artifact\n\n<!-- team-footer -->\n${lines.join("\n")}\n<!-- /team-footer -->${trailing}`;
}

function gate(
  phase: Phase,
  contents: string | undefined,
  options: {
    readonly profile?: StackProfile;
    readonly notes?: readonly { kind: string; text: string }[];
    readonly artifact?: string;
  } = {},
) {
  const root = tempRoot();
  const run = "run-1";
  const artifact = options.artifact ?? artifactNameForPhase(phase);
  if (artifact && contents !== undefined) writeArtifact(root, run, artifact, contents);
  return validatePhaseGate({
    phase,
    rootDir: root,
    runId: run,
    profile: options.profile ?? noTestProfile,
    notes: options.notes ?? [],
  });
}

function expectGate(
  result: ReturnType<typeof gate>,
  ok: boolean,
  code: GateCode,
): void {
  expect(result.ok).toBe(ok);
  expect(result.code).toBe(code);
}

describe("machine-readable footers", () => {
  test("parses a trailing footer, trims values, and keeps the last duplicate key", () => {
    const parsed = parseFooter(footer(["RESULT: FAIL", "RESULT: PASS", "EXIT:  0  "]));
    expect(parsed.present).toBe(true);
    expect(parsed.atEnd).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.values).toEqual({ RESULT: "PASS", EXIT: "0" });
  });

  test("reports a missing footer and an unclosed footer", () => {
    expect(parseFooter("# no footer\n")).toMatchObject({ present: false, atEnd: false, errors: [] });
    expect(parseFooter("<!-- team-footer -->\nRESULT: PASS\n")).toMatchObject({
      present: false,
      errors: ["Unclosed team-footer block."],
    });
  });

  test("requires the footer to be the last content and rejects malformed lines and keys", () => {
    const beforeContent = parseFooter(`${footer(["STATUS: APPROVED"])}\ntrailing text\n`);
    expect(beforeContent.present).toBe(true);
    expect(beforeContent.atEnd).toBe(false);

    const malformed = parseFooter(footer(["STATUS: APPROVED", "not a key"]));
    expect(malformed.errors).toEqual(["Unrecognized footer line: not a key"]);

    const wrongCase = parseFooter(footer(["status: approved"]));
    expect(wrongCase.present).toBe(true);
    expect(wrongCase.values).toEqual({});
    expect(wrongCase.errors[0]).toContain("Unrecognized footer line");
  });

  test("uses the last footer block and its keys are case-sensitive", () => {
    const parsed = parseFooter([
      "<!-- team-footer -->",
      "STATUS: REJECTED",
      "<!-- /team-footer -->",
      "more prose",
      "<!-- team-footer -->",
      "STATUS: APPROVED",
      "<!-- /team-footer -->",
    ].join("\n"));
    expect(parsed.present).toBe(true);
    expect(parsed.atEnd).toBe(true);
    expect(parsed.values.STATUS).toBe("APPROVED");
  });

  test("parses only safe integer values", () => {
    expect(parseInteger("0")).toBe(0);
    expect(parseInteger(" 12 ")).toBe(12);
    expect(parseInteger("-3")).toBe(-3);
    expect(parseInteger("1.5")).toBeUndefined();
    expect(parseInteger("abc")).toBeUndefined();
    expect(parseInteger("999999999999999999999999")).toBeUndefined();
    expect(parseInteger(undefined)).toBeUndefined();
  });
});

describe("phase gate table", () => {
  test("artifact-only phases require their artifact and nothing else", () => {
    for (const phase of ["brainstorm", "plan", "implement", "docs", "retro"] as const) {
      expect(artifactNameForPhase(phase)).toBe(PHASE_ARTIFACTS[phase]);
      expect(needsFooter(phase)).toBe(false);
      expectGate(gate(phase, undefined), false, "missing_artifact");
      expectGate(gate(phase, "# done\n"), true, "ok");
    }
    expect(artifactNameForPhase("done")).toBeUndefined();
    expectGate(gate("done", undefined), true, "ok");
  });

  test("spec requires APPROVED and a human_approval decision note", () => {
    expectGate(gate("spec", undefined), false, "missing_artifact");
    expectGate(gate("spec", "# Spec\n"), false, "missing_footer");
    expectGate(gate("spec", `${footer(["STATUS: APPROVED"])}\ntrailing\n`), false, "footer_not_at_end");
    expectGate(gate("spec", footer(["status: APPROVED"])), false, "invalid_footer");
    expectGate(gate("spec", footer(["STATUS: PENDING"])), false, "status_not_approved");
    expectGate(gate("spec", footer(["STATUS: APPROVED"])), false, "missing_approval_note");
    expectGate(
      gate("spec", footer(["STATUS: APPROVED"]), {
        notes: [{ kind: "finding", text: "human_approval looks fine" }],
      }),
      false,
      "missing_approval_note",
    );
    expectGate(
      gate("spec", footer(["STATUS: APPROVED"]), {
        notes: [{ kind: "decision", text: "Approved by the team." }],
      }),
      false,
      "missing_approval_note",
    );
    expectGate(
      gate("spec", footer(["STATUS: APPROVED"]), {
        notes: [{ kind: "decision", text: "human approval: the human said yes" }],
      }),
      true,
      "ok",
    );
    expectGate(
      gate("spec", footer(["STATUS: APPROVED"]), {
        notes: [{ kind: "decision", text: "human-approval recorded" }],
      }),
      true,
      "ok",
    );
  });

  test("test report PASS requires COMMAND and EXIT: 0", () => {
    expectGate(gate("test", "# Tests\n"), false, "missing_footer");
    expectGate(gate("test", footer(["RESULT: PASS", "EXIT: 0"])), false, "invalid_footer");
    expectGate(gate("test", footer(["RESULT: PASS", "COMMAND: bun test"])), false, "invalid_footer");
    expectGate(gate("test", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: no"])), false, "invalid_footer");
    expectGate(gate("test", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: 1"])), false, "test_not_passed");
    expectGate(gate("test", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: 0"])), true, "ok");
  });

  test("test report SKIPPED needs no test command and a decision note", () => {
    expectGate(
      gate("test", footer(["RESULT: SKIPPED"]), { profile: testCommandProfile }),
      false,
      "test_skipped_with_test_command",
    );
    expectGate(gate("test", footer(["RESULT: SKIPPED"])), false, "test_skipped_needs_justification");
    expectGate(
      gate("test", footer(["RESULT: SKIPPED"]), {
        notes: [{ kind: "decision", text: "This repository is documentation-only." }],
      }),
      true,
      "ok",
    );
    expectGate(gate("test", footer(["RESULT: SKIPPED"])), false, "test_skipped_needs_justification");
    expectGate(
      gate("test", footer(["RESULT: SKIPPED"]), {
        profile: testCommandProfile,
        notes: [{ kind: "decision", text: "No tests exist yet." }],
      }),
      false,
      "test_skipped_with_test_command",
    );
  });

  test("test report FAIL, unknown results, and malformed footer fail", () => {
    expectGate(gate("test", footer(["RESULT: FAIL", "COMMAND: bun test", "EXIT: 1"])), false, "test_not_passed");
    expectGate(gate("test", footer(["RESULT: MAYBE", "EXIT: 0"])), false, "invalid_footer");
    expectGate(gate("test", footer(["RESULT: PASS", "COMMAND: bun test", "EXIT: 0", "broken"])), false, "invalid_footer");
  });

  test("qa requires VERDICT: PASS", () => {
    expectGate(gate("qa", undefined), false, "missing_artifact");
    expectGate(gate("qa", footer(["VERDICT: FAIL"])), false, "verdict_not_pass");
    expectGate(gate("qa", footer(["VERDICT: pass"])), false, "verdict_not_pass");
    expectGate(gate("qa", footer(["VERDICT: PASS"])), true, "ok");
  });

  test("adversary requires an integer BLOCKERS count of zero", () => {
    expectGate(gate("adversary", footer(["BLOCKERS: many"])), false, "invalid_footer");
    expectGate(gate("adversary", footer(["BLOCKERS: 2"])), false, "blockers");
    expectGate(gate("adversary", footer(["BLOCKERS: 0"])), true, "ok");
  });

  test("covers every phase name exactly once in the artifact table", () => {
    const artifactPhases = Object.keys(PHASE_ARTIFACTS).sort();
    expect(artifactPhases).toEqual(PHASES.filter((phase) => phase !== "done").sort());
  });
});
