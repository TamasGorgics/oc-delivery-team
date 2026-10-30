import { isEarlierPhase, isPhase, type Phase } from "../state/phases";
import {
  defineTeamTool,
  failure,
  hasExplicitInputKeys,
  objectSchema,
  ok,
  readOptionalString,
  readRequiredString,
  readToolInput,
  requireServices,
  resolveRun,
  toolIdentity,
  touchSession,
  type ToolRuntime,
} from "./runtime";

interface RewindInput {
  readonly run?: string;
  readonly to: Phase;
  readonly reason: string;
}

export function createRewindTool(runtime: ToolRuntime) {
  return defineTeamTool<RewindInput>(runtime, {
    name: "team_rewind",
    description: "Move an open run back to an earlier phase, enforcing the per-phase loop cap.",
    input: objectSchema({
      run: { type: "string", description: "Optional run id." },
      to: { type: "string", description: "Earlier phase to re-enter." },
      reason: { type: "string", description: "Why the run is rewinding." },
    }, ["to", "reason"]),
    execute: async (raw, context) => {
      const input = readToolInput(raw);
      hasExplicitInputKeys(input, ["run", "to", "reason"]);
      const runId = readOptionalString(input, "run");
      const to = input.to;
      if (!isPhase(to) || to === "done") return failure("to must be an earlier phase name.", "invalid_input");
      const reason = readRequiredString(input, "reason", { max: 2_000 });
      const services = requireServices(runtime);
      const identity = toolIdentity(context);
      touchSession(runtime, context);

      const resolved = resolveRun(runtime, runId, identity.sessionId);
      if (!resolved.ok) return failure(resolved.message, resolved.code);
      const run = resolved.run;
      touchSession(runtime, context, run.id);

      if (run.status !== "open") {
        return failure(`Run ${run.id} is ${run.status}; only an open run can rewind.`, "run_not_open");
      }
      if (!isEarlierPhase(to, run.phase)) {
        return failure(`Cannot rewind from ${run.phase} to ${to}; the target must be earlier.`, "invalid_transition");
      }

      const count = services.runs.incrementLoop(run.id, to);
      const maxLoops = runtime.config.maxLoops;
      runtime.trace.event(
        "loop.incremented",
        { phase: to, count, max_loops: maxLoops },
        { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: run.phase },
      );
      if (count > maxLoops) {
        runtime.trace.event(
          "loop.exceeded",
          { phase: to, count, max_loops: maxLoops, action: "ESCALATE_TO_HUMAN" },
          { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: run.phase },
        );
        return failure(
          `ESCALATE_TO_HUMAN: re-entering ${to} would exceed maxLoops=${maxLoops} (count ${count}). Stop retrying and ask the human how to proceed.`,
          "ESCALATE_TO_HUMAN",
          { escalation: "ESCALATE_TO_HUMAN", phase: to, count, max_loops: maxLoops },
        );
      }

      const now = new Date().toISOString();
      services.db.transaction(() => {
        services.runs.addTransition({
          runId: run.id,
          from: run.phase,
          to,
          kind: "rewind",
          reason,
          at: now,
        });
        services.runs.updatePhase(run.id, to);
      });
      runtime.trace.event(
        "phase.rewound",
        { from: run.phase, to, reason, count },
        { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: to },
      );

      return ok(
        {
          run: run.id,
          from: run.phase,
          to,
          phase: to,
          loop_count: count,
          remaining: Math.max(0, maxLoops - count),
          max_loops: maxLoops,
        },
        `Run ${run.id} rewound from ${run.phase} to ${to}. Loop ${count}/${maxLoops}; ${Math.max(0, maxLoops - count)} remaining.`,
      );
    },
  });
}
