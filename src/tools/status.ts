import { validatePhaseGate, type GateResult } from "../state/artifacts";
import {
  PHASE_OWNERS,
  isReviewPhase,
  isReviewPhaseDisabled,
  nextAdvanceTarget,
  type ReviewPhase,
} from "../state/phases";
import {
  REVIEW_MEMBERS,
  disabledReviewGate,
  evaluateReviewBarrier,
  reviewWaveStatus,
  serializeGateResult,
  serializeReviewWave,
  type ReviewBarrierResult,
  type ReviewRole,
  type ReviewWaveMemberLoop,
  type ReviewWaveStatus,
} from "../state/reviews";
import { parseJsonRecord, type LoopRow, type RunRow, type ToolCallRow } from "../state/runs";
import type { RoleId } from "../roles";
import { StackService } from "../stack/service";
import {
  defineTeamTool,
  failure,
  hasExplicitInputKeys,
  objectSchema,
  ok,
  readOptionalString,
  readToolInput,
  requireServices,
  resolveRun,
  toolIdentity,
  touchSession,
  type ToolRuntime,
} from "./runtime";

interface StatusInput {
  readonly run?: string;
}

export function createStatusTool(runtime: ToolRuntime) {
  return defineTeamTool<StatusInput>(runtime, {
    name: "team_status",
    description: "Show the current run phase, gate status, loops, notes, counters, and recent events.",
    input: objectSchema({
      run: { type: "string", description: "Optional run id." },
    }),
    execute: async (raw, context) => {
      const input = readToolInput(raw);
      hasExplicitInputKeys(input, ["run"]);
      const runId = readOptionalString(input, "run");
      const services = requireServices(runtime);
      const identity = toolIdentity(context);
      touchSession(runtime, context);

      const resolved = resolveRun(runtime, runId, identity.sessionId);
      if (!resolved.ok) return failure(resolved.message, resolved.code);
      const run = resolved.run;
      touchSession(runtime, context, run.id);

      const transitions = services.runs.getTransitions(run.id);
      const loops = services.runs.getLoops(run.id);
      const notes = services.runs.listNotes(run.id);
      const events = services.runs.listRecentEvents(run.id, 10);
      const recentToolCalls = services.runs.listRecentToolCalls(run.id, 10);
      const messageTotals = services.runs.messageTotals(run.id);
      const maxLoops = runtime.config.maxLoops;
      const counters = {
        tool_calls: services.runs.countToolCalls(run.id),
        tool_failures: services.runs.countToolFailures(run.id),
        gate_denials: services.runs.countEvents(run.id, "gate.denied"),
        gate_unresolved: services.runs.countEvents(run.id, "gate.unresolved"),
        loops: loops.reduce((total, loop) => total + Number(loop.count), 0),
        messages: messageTotals.messages,
        tokens_in: messageTotals.tokens_in,
        tokens_out: messageTotals.tokens_out,
        cost: messageTotals.cost,
      };
      const profile = stackService(runtime).resolveForRun(run, false).profile;
      const enabled = runtime.config.reviews.parallel;
      const disabledRoles = runtime.config.roles.disabled;
      const barrier = enabled && run.status === "open" && run.phase === "qa"
        ? evaluateReviewBarrier({
            rootDir: runtime.config.rootDir,
            runId: run.id,
            profile,
            notes,
          })
        : undefined;
      const gate = barrier ?? (isReviewPhaseDisabled(run.phase, disabledRoles) && isReviewPhase(run.phase)
        ? disabledReviewGate(run.phase)
        : validatePhaseGate({
            phase: run.phase,
            rootDir: runtime.config.rootDir,
            runId: run.id,
            profile,
            notes,
          }));
      const memberLoops = reviewMemberLoops(loops, maxLoops);
      const reviewWave = reviewWaveStatus({
        enabled,
        run,
        rootDir: runtime.config.rootDir,
        profile,
        notes,
        transitions,
        memberLoops,
        ...(barrier ? { barrier } : {}),
      });
      const modelWarnings = events
        .filter((event) => event.kind.startsWith("model."))
        .map((event) => ({ kind: event.kind, data: parseJsonRecord(event.data_json) }));
      const loopSummary = loopCounts(loops.filter((loop) => loop.role === ""));
      const roleLoops = roleLoopSummary(loops, maxLoops);
      const owner = PHASE_OWNERS[run.phase];
      const nextAction = nextActionFor(run, gate, owner, barrier, disabledRoles);
      const waveLine = enabled ? renderWaveLine(reviewWave) : undefined;

      return ok(
        {
          run: run.id,
          title: run.title,
          status: run.status,
          phase: run.phase,
          owner,
          gate: serializeGateResult(gate),
          loops: loopSummary,
          ...(roleLoops.length > 0 ? { role_loops: roleLoops } : {}),
          counters,
          notes: notes.length,
          open_lessons: services.lessons.countOpen(),
          models: { warnings: modelWarnings },
          review_wave: serializeReviewWave(reviewWave),
          recent_events: events.map((event) => ({
            kind: event.kind,
            at: event.at,
            data: parseJsonRecord(event.data_json),
          })),
          recent_tool_calls: recentToolCalls.map(toolCallPayload),
          next_action: nextAction,
        },
        renderStatus(run, gate, owner, loopSummary, counters, notes.length, services.lessons.countOpen(), nextAction, waveLine),
      );
    },
  });
}

function stackService(runtime: ToolRuntime): StackService {
  return new StackService({
    rootDir: runtime.config.rootDir,
    projectDir: runtime.config.projectDir,
    config: runtime.config.stack,
    runs: runtime.runs,
  });
}

function loopCounts(loops: readonly LoopRow[]): Record<string, number> {
  return Object.fromEntries(loops.map((loop) => [loop.phase, Number(loop.count)]));
}

function roleLoopSummary(loops: readonly LoopRow[], maxLoops: number): Array<Record<string, unknown>> {
  return loops
    .filter((loop) => loop.role !== "")
    .map((loop) => {
      const count = Number(loop.count);
      return {
        phase: loop.phase,
        role: loop.role,
        count,
        remaining: Math.max(0, maxLoops - count),
        escalated: count > maxLoops,
      };
    });
}

function reviewMemberLoops(
  loops: readonly LoopRow[],
  maxLoops: number,
): Readonly<Partial<Record<ReviewRole, ReviewWaveMemberLoop>>> {
  return Object.fromEntries(
    REVIEW_MEMBERS.map((role) => {
      const row = loops.find((loop) => loop.phase === "qa" && loop.role === role);
      const count = row ? Number(row.count) : 0;
      return [role, {
        count,
        remaining: Math.max(0, maxLoops - count),
        escalated: count > maxLoops,
      }];
    }),
  );
}

function nextActionFor(
  run: RunRow,
  gate: GateResult,
  owner: string | null,
  barrier: ReviewBarrierResult | undefined,
  disabled: readonly RoleId[],
): string {
  if (run.status !== "open") return "The run is not open; inspect the status or start a new run.";
  if (run.phase === "done") return "The run is done and terminal.";
  if (barrier) {
    if (barrier.ok) {
      return "Review wave ready: both qa.md and adversary.md passed. Call team_advance to move qa -> docs.";
    }
    const failing = barrier.members
      .filter((member) => !member.ok)
      .map((member) => `${member.role} (${member.artifact})`)
      .join(", ");
    const retryRoles = barrier.members
      .filter((member) => !member.ok)
      .map((member) => `team_loop(role="${member.role}")`)
      .join(" / ");
    return `Review wave not ready: ${failing} still failing. Re-dispatch those reviewers concurrently or sequentially in qa and use ${retryRoles} for retries; team_advance moves qa -> docs only after both artifacts pass.`;
  }

  const target = nextAdvanceTarget(run.phase, disabled);
  const skipped = target?.skipped ?? [];
  const skipNote = skipped.length > 0 && target
    ? ` The next advance skips ${formatReviewPhases(skipped)} (disabled) and moves ${run.phase} -> ${target.target}; do not request an artifact from a disabled reviewer.`
    : "";

  if (isReviewPhaseDisabled(run.phase, disabled)) {
    return target
      ? `The ${run.phase} review role is disabled; no review artifact is required. Call team_advance to skip ${run.phase} and move to ${target.target}.`
      : "The disabled review phase has no next phase; inspect the status.";
  }
  if (gate.ok) return `Call team_advance to move to the next phase.${skipNote}`;
  if (run.phase === "plan") {
    return `${gate.message} Re-dispatch the spec subagent to write plan.md; never use the built-in plan agent.${skipNote}`;
  }
  return owner ? `${gate.message} Owner: ${owner}.${skipNote}` : `${gate.message}${skipNote}`;
}

function formatReviewPhases(phases: readonly ReviewPhase[]): string {
  return phases.length === 1 ? phases[0]! : phases.join(" and ");
}

function renderWaveLine(status: ReviewWaveStatus): string {
  if (!status.active) return `Review wave: enabled; not active in ${status.phase}.`;
  const members = status.members
    .map((member) => {
      const outcome = member.gate?.ok ? "pass" : "fail";
      const loop = member.loop
        ? ` retries ${member.loop.count}${member.loop.escalated ? " (escalated)" : ""}`
        : "";
      return `${member.role}=${outcome}${loop}`;
    })
    .join(", ");
  return `Review wave: active in qa; ${status.ready ? "ready" : "not ready"}; generation ${status.generation}; ${members}.`;
}

function renderStatus(
  run: RunRow,
  gate: GateResult,
  owner: string | null,
  loops: Record<string, number>,
  counters: StatusCounters,
  notes: number,
  openLessons: number,
  nextAction: string,
  waveLine?: string,
): string {
  const loopText = Object.keys(loops).length === 0
    ? "none"
    : Object.entries(loops).map(([phase, count]) => `${phase}=${count}`).join(", ");
  const toolText = counters.tool_calls === 0
    ? "no tool calls"
    : `${counters.tool_calls} tool calls (${counters.tool_failures} failed)`;
  const messageText = counters.messages === 0
    ? "no messages"
    : `${counters.messages} messages, ${counters.tokens_in} in / ${counters.tokens_out} out tokens, $${counters.cost.toFixed(6)}`;
  return [
    `Run ${run.id}: ${run.title}`,
    `Status: ${run.status}; phase: ${run.phase}; owner: ${owner ?? "none"}`,
    `Gate: ${gate.ok ? "open" : `blocked (${gate.code})`} — ${gate.message}`,
    `Loops: ${loopText} (${counters.loops} total); notes: ${notes}; open lessons: ${openLessons}.`,
    ...(waveLine ? [waveLine] : []),
    `Tools: ${toolText}; gate denials: ${counters.gate_denials}; unresolved: ${counters.gate_unresolved}.`,
    `Messages: ${messageText}.`,
    `Next: ${nextAction}`,
  ].join("\n");
}

interface StatusCounters {
  readonly tool_calls: number;
  readonly tool_failures: number;
  readonly gate_denials: number;
  readonly gate_unresolved: number;
  readonly loops: number;
  readonly messages: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost: number;
}

function toolCallPayload(row: ToolCallRow): Record<string, unknown> {
  return {
    tool: row.tool,
    at: row.started_at,
    agent: row.agent,
    phase: row.phase,
    ok: row.ok === null ? null : row.ok === 1,
    duration_ms: row.duration_ms,
    output_bytes: row.output_bytes,
  };
}
