import { readFileSync } from "node:fs";
import type { StackProfile } from "../stack/profile";
import { profileHasTestCommand } from "../stack/profile";
import { runArtifactPath } from "./paths";
import type { ArtifactPhase, Phase } from "./phases";

export interface NoteLike {
  readonly kind: string;
  readonly text: string;
}

export interface FooterParseResult {
  readonly present: boolean;
  readonly atEnd: boolean;
  readonly values: Readonly<Record<string, string>>;
  readonly errors: readonly string[];
}

export type GateCode =
  | "ok"
  | "missing_artifact"
  | "missing_footer"
  | "footer_not_at_end"
  | "invalid_footer"
  | "status_not_approved"
  | "missing_approval_note"
  | "test_not_passed"
  | "test_skipped_with_test_command"
  | "test_skipped_needs_justification"
  | "verdict_not_pass"
  | "blockers";

export interface GateResult {
  readonly ok: boolean;
  readonly code: GateCode;
  readonly message: string;
  readonly artifact: string;
  readonly artifactPath: string;
  readonly footer?: FooterParseResult;
}

export const PHASE_ARTIFACTS: Readonly<Record<ArtifactPhase, string>> = {
  brainstorm: "brainstorm.md",
  spec: "spec.md",
  plan: "plan.md",
  implement: "impl-notes.md",
  test: "test-report.md",
  qa: "qa.md",
  adversary: "adversary.md",
  docs: "docs.md",
  retro: "retro.md",
};

const FOOTER_START = /<!--\s*team-footer\s*-->/g;
const FOOTER_BLOCK = /<!--\s*team-footer\s*-->([\s\S]*?)<!--\s*\/team-footer\s*-->/g;
const FOOTER_KEY = /^([A-Z][A-Z0-9_]*):(?:\s*(.*))?$/;

export function parseFooter(text: string): FooterParseResult {
  const matches = [...text.matchAll(FOOTER_BLOCK)];
  if (matches.length === 0) {
    const opener = new RegExp(FOOTER_START.source).test(text);
    return {
      present: false,
      atEnd: false,
      values: {},
      errors: opener ? ["Unclosed team-footer block."] : [],
    };
  }

  const last = matches[matches.length - 1];
  const body = last[1] ?? "";
  const values: Record<string, string> = {};
  const errors: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = FOOTER_KEY.exec(line);
    if (!match) {
      errors.push(`Unrecognized footer line: ${line}`);
      continue;
    }
    values[match[1] as string] = (match[2] ?? "").trim();
  }

  const matchIndex = last.index ?? 0;
  const end = matchIndex + last[0].length;
  return {
    present: true,
    atEnd: text.slice(end).trim().length === 0,
    values,
    errors,
  };
}

export function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function validatePhaseGate(input: {
  readonly phase: Phase;
  readonly rootDir: string;
  readonly runId: string;
  readonly profile: StackProfile;
  readonly notes: readonly NoteLike[];
}): GateResult {
  if (input.phase === "done") {
    return {
      ok: true,
      code: "ok",
      message: "The run is done.",
      artifact: "",
      artifactPath: "",
    };
  }

  const artifact = PHASE_ARTIFACTS[input.phase];
  const artifactPath = runArtifactPath(input.rootDir, input.runId, artifact);
  let contents: string;
  try {
    contents = readFileSync(artifactPath, "utf8");
  } catch {
    return {
      ok: false,
      code: "missing_artifact",
      message: `Missing artifact ${artifact} at <run>/${artifact}. Write it before leaving '${input.phase}'.`,
      artifact,
      artifactPath,
    };
  }

  if (!needsFooter(input.phase)) {
    return { ok: true, code: "ok", message: `${artifact} exists.`, artifact, artifactPath };
  }

  const footer = parseFooter(contents);
  if (!footer.present) {
    return {
      ok: false,
      code: "missing_footer",
      message: `Missing machine-readable footer in <run>/${artifact}. Add a <!-- team-footer --> block with ${expectedFooter(input.phase)}.`,
      artifact,
      artifactPath,
      footer,
    };
  }
  if (!footer.atEnd) {
    return {
      ok: false,
      code: "footer_not_at_end",
      message: `The team-footer block in <run>/${artifact} must be the last content in the file.`,
      artifact,
      artifactPath,
      footer,
    };
  }
  if (footer.errors.length > 0) {
    return {
      ok: false,
      code: "invalid_footer",
      message: `Invalid team-footer in <run>/${artifact}: ${footer.errors[0]}`,
      artifact,
      artifactPath,
      footer,
    };
  }

  switch (input.phase) {
    case "spec":
      return validateSpec(footer, artifact, artifactPath, input.notes);
    case "test":
      return validateTest(footer, artifact, artifactPath, input.profile, input.notes);
    case "qa":
      return validateExact(footer, artifact, artifactPath, "VERDICT", "PASS", "verdict_not_pass");
    case "adversary":
      return validateBlockers(footer, artifact, artifactPath);
    case "brainstorm":
    case "plan":
    case "implement":
    case "docs":
    case "retro":
      return { ok: true, code: "ok", message: `${artifact} exists.`, artifact, artifactPath, footer };
  }
}

export function artifactNameForPhase(phase: Phase): string | undefined {
  return phase === "done" ? undefined : PHASE_ARTIFACTS[phase];
}

export function needsFooter(phase: Phase): boolean {
  return phase === "spec" || phase === "test" || phase === "qa" || phase === "adversary";
}

function validateSpec(
  footer: FooterParseResult,
  artifact: string,
  artifactPath: string,
  notes: readonly NoteLike[],
): GateResult {
  if (footer.values.STATUS !== "APPROVED") {
    return {
      ok: false,
      code: "status_not_approved",
      message: `spec.md must end with STATUS: APPROVED before leaving 'spec'. Ask the human to approve it, then update the footer.`,
      artifact,
      artifactPath,
      footer,
    };
  }
  if (!notes.some((note) => note.kind === "decision" && /human[_\s-]?approval/i.test(note.text))) {
    return {
      ok: false,
      code: "missing_approval_note",
      message: `spec.md is marked approved, but there is no decision note recording human approval. Ask the human, then call team_note(kind="decision", text="human_approval ...").`,
      artifact,
      artifactPath,
      footer,
    };
  }
  return { ok: true, code: "ok", message: "Specification approved.", artifact, artifactPath, footer };
}

function validateTest(
  footer: FooterParseResult,
  artifact: string,
  artifactPath: string,
  profile: StackProfile,
  notes: readonly NoteLike[],
): GateResult {
  const result = footer.values.RESULT;
  if (result === "PASS") {
    const command = footer.values.COMMAND;
    if (!command) {
      return {
        ok: false,
        code: "invalid_footer",
        message: "test-report.md with RESULT: PASS must also include COMMAND: <exact test command from the Stack Profile>.",
        artifact,
        artifactPath,
        footer,
      };
    }
    const exit = parseInteger(footer.values.EXIT);
    if (exit === undefined) {
      return {
        ok: false,
        code: "invalid_footer",
        message: "test-report.md must include an integer EXIT code. RESULT: PASS requires EXIT: 0.",
        artifact,
        artifactPath,
        footer,
      };
    }
    if (exit !== 0) {
      return {
        ok: false,
        code: "test_not_passed",
        message: `test-report.md says RESULT: PASS but EXIT is ${exit}. A passing test report requires EXIT: 0.`,
        artifact,
        artifactPath,
        footer,
      };
    }
    return { ok: true, code: "ok", message: "Tests passed.", artifact, artifactPath, footer };
  }

  if (result === "SKIPPED") {
    if (profileHasTestCommand(profile)) {
      return {
        ok: false,
        code: "test_skipped_with_test_command",
        message: "test-report.md is SKIPPED, but the Stack Profile defines a test command. Run it or remove the command from the profile.",
        artifact,
        artifactPath,
        footer,
      };
    }
    if (!notes.some((note) => note.kind === "decision" && note.text.trim().length > 0)) {
      return {
        ok: false,
        code: "test_skipped_needs_justification",
        message: "test-report.md is SKIPPED. Record why with team_note(kind=\"decision\") before leaving 'test'.",
        artifact,
        artifactPath,
        footer,
      };
    }
    return { ok: true, code: "ok", message: "Tests skipped with a decision note.", artifact, artifactPath, footer };
  }

  if (result === "FAIL") {
    return {
      ok: false,
      code: "test_not_passed",
      message: "test-report.md reports RESULT: FAIL. Rewind to implement, fix the failure, and rerun the tests.",
      artifact,
      artifactPath,
      footer,
    };
  }

  return {
    ok: false,
    code: "invalid_footer",
    message: "test-report.md must include RESULT: PASS|FAIL|SKIPPED, COMMAND, and EXIT.",
    artifact,
    artifactPath,
    footer,
  };
}

function validateExact(
  footer: FooterParseResult,
  artifact: string,
  artifactPath: string,
  key: string,
  expected: string,
  code: GateCode,
): GateResult {
  if (footer.values[key] !== expected) {
    return {
      ok: false,
      code,
      message: `${artifact} must end with ${key}: ${expected} before leaving this phase.`,
      artifact,
      artifactPath,
      footer,
    };
  }
  return { ok: true, code: "ok", message: `${artifact} satisfied.`, artifact, artifactPath, footer };
}

function validateBlockers(
  footer: FooterParseResult,
  artifact: string,
  artifactPath: string,
): GateResult {
  const blockers = parseInteger(footer.values.BLOCKERS);
  if (blockers === undefined) {
    return {
      ok: false,
      code: "invalid_footer",
      message: "adversary.md must include an integer BLOCKERS count.",
      artifact,
      artifactPath,
      footer,
    };
  }
  if (blockers !== 0) {
    return {
      ok: false,
      code: "blockers",
      message: `adversary.md reports ${blockers} blocker(s). Resolve them or rewind before leaving 'adversary'.`,
      artifact,
      artifactPath,
      footer,
    };
  }
  return { ok: true, code: "ok", message: "No blockers.", artifact, artifactPath, footer };
}

function expectedFooter(phase: Phase): string {
  switch (phase) {
    case "spec":
      return "STATUS: APPROVED";
    case "test":
      return "RESULT: PASS, COMMAND: <command>, and EXIT: 0 (or a justified RESULT: SKIPPED)";
    case "qa":
      return "VERDICT: PASS";
    case "adversary":
      return "BLOCKERS: 0";
    default:
      return "the required keys";
  }
}
