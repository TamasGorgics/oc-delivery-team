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

export function assertNeverPhase(phase: never): never {
  throw new Error(`Unexpected phase: ${String(phase)}`);
}
