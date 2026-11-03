import type { RoleId } from "../roles";

export const PHASES = [
  "brainstorm",
  "spec",
  "plan",
  "implement",
  "test",
  "qa",
  "adversary",
  "docs",
  "retro",
  "done",
] as const;

export type Phase = (typeof PHASES)[number];

export type ReviewPhase = "qa" | "adversary";

export const PHASE_OWNERS: Readonly<Record<Phase, RoleId | null>> = {
  brainstorm: "researcher",
  spec: "spec",
  plan: "spec",
  implement: "developer",
  test: "tester",
  qa: "qa",
  adversary: "adversary",
  docs: "docs",
  retro: "retro",
  done: null,
};

export const ARTIFACT_PHASES = [
  "brainstorm",
  "spec",
  "plan",
  "implement",
  "test",
  "qa",
  "adversary",
  "docs",
  "retro",
] as const;

export type ArtifactPhase = (typeof ARTIFACT_PHASES)[number];

export function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

export function isArtifactPhase(value: unknown): value is ArtifactPhase {
  return typeof value === "string" && (ARTIFACT_PHASES as readonly string[]).includes(value);
}

export function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase);
}

export function isEarlierPhase(candidate: Phase, current: Phase): boolean {
  return phaseIndex(candidate) < phaseIndex(current);
}

export function nextPhase(phase: Phase): Phase | undefined {
  const index = phaseIndex(phase);
  return index >= 0 && index < PHASES.length - 1 ? PHASES[index + 1] : undefined;
}

export function isReviewPhase(phase: Phase): phase is ReviewPhase {
  return phase === "qa" || phase === "adversary";
}

export function isReviewPhaseDisabled(phase: Phase, disabled: readonly RoleId[]): boolean {
  return isReviewPhase(phase) && disabled.includes(phase);
}

export interface AdvanceTarget {
  readonly target: Phase;
  readonly skipped: readonly ReviewPhase[];
}

/**
 * Sequential advance target that bypasses review phases whose role is disabled.
 * A disabled review role has no registered agent, so it must never own a gate.
 */
export function nextAdvanceTarget(phase: Phase, disabled: readonly RoleId[]): AdvanceTarget | undefined {
  let cursor = nextPhase(phase);
  const skipped: ReviewPhase[] = [];
  while (cursor && isReviewPhase(cursor) && disabled.includes(cursor)) {
    skipped.push(cursor);
    cursor = nextPhase(cursor);
  }
  return cursor ? { target: cursor, skipped } : undefined;
}

export function assertNeverPhase(phase: never): never {
  throw new Error(`Unexpected phase: ${String(phase)}`);
}
