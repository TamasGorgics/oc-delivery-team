import type { StackProfile } from "../stack/profile";
import {
  validatePhaseGate,
  type GateMemberResult,
  type GateResult,
  type NoteLike,
} from "./artifacts";
import { runArtifactPath } from "./paths";
import { nextPhase, type Phase } from "./phases";
import type { PhaseTransitionRow, RunStatus } from "./runs";

/**
 * The review wave keeps the fixed `qa` phase and requires the two reviewer
 * artifacts together. Order is part of the contract: `qa` is always evaluated
 * before `adversary`, and a failing member never short-circuits the other one.
 */
export const REVIEW_MEMBERS = ["qa", "adversary"] as const;

export type ReviewRole = (typeof REVIEW_MEMBERS)[number];

export const REVIEW_ARTIFACTS: Readonly<Record<ReviewRole, string>> = {
  qa: "qa.md",
  adversary: "adversary.md",
};

export function isReviewRole(value: unknown): value is ReviewRole {
  return typeof value === "string" && (REVIEW_MEMBERS as readonly string[]).includes(value);
}

/**
 * In an enabled wave the `qa` phase owns the whole review barrier and advances
 * straight to `docs`. Every other phase keeps the sequential target.
 */
export function reviewAdvanceTarget(phase: Phase, enabled: boolean): Phase | undefined {
  if (enabled && phase === "qa") return "docs";
  return nextPhase(phase);
}

export interface ReviewBarrierInput {
  readonly rootDir: string;
  readonly runId: string;
  readonly profile: StackProfile;
  readonly notes: readonly NoteLike[];
}

export interface ReviewBarrierResult extends GateResult {
  readonly members: readonly GateMemberResult[];
  readonly ready: boolean;
}

/**
 * Evaluate both reviewer gates in fixed order without short-circuiting. The
 * first failing member supplies the top-level code/artifact/path/footer, while
 * the message names every failing member so one call exposes both retries.
 */
export function evaluateReviewBarrier(input: ReviewBarrierInput): ReviewBarrierResult {
  const members = REVIEW_MEMBERS.map((role) => evaluateMember(role, input));
  const failing = members.filter((member) => !member.ok);
  const firstFailure = failing[0];
  const ok = failing.length === 0;

  return {
    ok,
    ready: ok,
    code: firstFailure?.code ?? "ok",
    message: ok ? successMessage() : aggregateMessage(failing),
    artifact: firstFailure?.artifact ?? members[0]?.artifact ?? "",
    artifactPath: firstFailure?.artifact_path ?? members[0]?.artifact_path ?? "",
    ...(firstFailure?.footer ? { footer: firstFailure.footer } : {}),
    members,
  };
}

function evaluateMember(role: ReviewRole, input: ReviewBarrierInput): GateMemberResult {
  const result = validatePhaseGate({
    phase: role,
    rootDir: input.rootDir,
    runId: input.runId,
    profile: input.profile,
    notes: input.notes,
  });
  return {
    role,
    ok: result.ok,
    code: result.code,
    message: result.message,
    artifact: result.artifact,
    artifact_path: result.artifactPath,
    ...(result.footer ? { footer: result.footer } : {}),
  };
}

function successMessage(): string {
  return "Review wave passed: qa.md and adversary.md satisfy their gates.";
}

function aggregateMessage(failing: readonly GateMemberResult[]): string {
  const details = failing
    .map((member) => `${member.role} (${member.artifact}): ${member.message}`)
    .join(" ");
  return `Review wave not ready; both reviewers must pass before advancing qa -> docs. ${details}`;
}

export interface ReviewWaveRun {
  readonly id: string;
  readonly phase: Phase;
  readonly status: RunStatus;
}

export interface ReviewWaveMemberLoop {
  readonly count: number;
  readonly remaining: number;
  readonly escalated: boolean;
}

export interface ReviewWaveMember {
  readonly role: ReviewRole;
  readonly artifact: string;
  readonly artifact_path: string;
  /** `null` unless the wave is active. */
  readonly gate: GateResult | null;
  /** Populated by `team_status` for active members. */
  readonly loop?: ReviewWaveMemberLoop;
}

export interface ReviewWaveStatus {
  readonly enabled: boolean;
  readonly active: boolean;
  readonly ready: boolean;
  readonly phase: Phase;
  readonly members: readonly ReviewWaveMember[];
  readonly artifacts: Readonly<Partial<Record<ReviewRole, string>>>;
  readonly started_at?: string;
  readonly generation: number;
}

export interface ReviewWaveStatusInput {
  readonly enabled: boolean;
  readonly run: ReviewWaveRun;
  readonly rootDir: string;
  readonly profile: StackProfile;
  readonly notes?: readonly NoteLike[];
  /** Phase transitions for the run, in insertion order. */
  readonly transitions: readonly PhaseTransitionRow[];
  /** Optional per-role loop detail from the repository; used by `team_status`. */
  readonly memberLoops?: Readonly<Partial<Record<ReviewRole, ReviewWaveMemberLoop>>>;
}

function reviewEntries(transitions: readonly PhaseTransitionRow[]): PhaseTransitionRow[] {
  return transitions.filter(
    (transition) =>
      transition.to_phase === "qa"
      && (transition.kind === "advance" || transition.kind === "rewind"),
  );
}

/**
 * Pure, read-only derivation of the additive `review_wave` payload. The caller
 * supplies the repository reads (transitions and optional member loops); this
 * helper never writes events, loops, or files.
 */
export function reviewWaveStatus(input: ReviewWaveStatusInput): ReviewWaveStatus {
  const entries = reviewEntries(input.transitions);
  const generation = entries.length;
  const latestEntry = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const active = input.enabled && input.run.status === "open" && input.run.phase === "qa";

  if (!input.enabled) {
    return {
      enabled: false,
      active: false,
      ready: false,
      phase: input.run.phase,
      members: [],
      artifacts: {},
      generation,
    };
  }

  const artifacts = artifactsFor(input.rootDir, input.run.id);
  const barrier = active
    ? evaluateReviewBarrier({
        rootDir: input.rootDir,
        runId: input.run.id,
        profile: input.profile,
        notes: input.notes ?? [],
      })
    : undefined;

  const members: ReviewWaveMember[] = REVIEW_MEMBERS.map((role, index) => {
    const member = barrier?.members[index];
    return {
      role,
      artifact: REVIEW_ARTIFACTS[role],
      artifact_path: artifacts[role],
      gate: member ? toGateResult(member) : null,
      ...(active && input.memberLoops?.[role] ? { loop: input.memberLoops[role] } : {}),
    };
  });

  return {
    enabled: true,
    active,
    ready: barrier?.ok === true,
    phase: input.run.phase,
    members,
    artifacts,
    ...(active && latestEntry ? { started_at: latestEntry.at } : {}),
    generation,
  };
}

function artifactsFor(rootDir: string, runId: string): Readonly<Record<ReviewRole, string>> {
  return {
    qa: runArtifactPath(rootDir, runId, REVIEW_ARTIFACTS.qa),
    adversary: runArtifactPath(rootDir, runId, REVIEW_ARTIFACTS.adversary),
  };
}

function toGateResult(member: GateMemberResult): GateResult {
  return {
    ok: member.ok,
    code: member.code,
    message: member.message,
    artifact: member.artifact,
    artifactPath: member.artifact_path,
    ...(member.footer ? { footer: member.footer } : {}),
  };
}

/** Shared payload shape for a single gate (including barrier members). */
export function serializeGateResult(gate: GateResult): Record<string, unknown> {
  return {
    ok: gate.ok,
    code: gate.code,
    message: gate.message,
    artifact: gate.artifact,
    artifact_path: gate.artifactPath,
    ...(gate.footer ? { footer: gate.footer.values } : {}),
    ...(gate.members ? { members: gate.members.map(serializeGateMemberResult) } : {}),
  };
}

/** Shared payload shape for one barrier member. */
export function serializeGateMemberResult(member: GateMemberResult): Record<string, unknown> {
  return {
    role: member.role,
    ok: member.ok,
    code: member.code,
    message: member.message,
    artifact: member.artifact,
    artifact_path: member.artifact_path,
    ...(member.footer ? { footer: member.footer.values } : {}),
  };
}

/** Shared payload shape for the additive `review_wave` object. */
export function serializeReviewWave(status: ReviewWaveStatus): Record<string, unknown> {
  return {
    enabled: status.enabled,
    active: status.active,
    ready: status.ready,
    phase: status.phase,
    members: status.members.map((member) => ({
      role: member.role,
      artifact: member.artifact,
      artifact_path: member.artifact_path,
      gate: member.gate ? serializeGateResult(member.gate) : null,
      ...(member.loop ? { loop: { ...member.loop } } : {}),
    })),
    artifacts: { ...status.artifacts },
    ...(status.started_at ? { started_at: status.started_at } : {}),
    generation: status.generation,
  };
}
