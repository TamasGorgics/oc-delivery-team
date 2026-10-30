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

interface LoopInput {
  readonly run?: string;
  readonly reason: string;
}

export function createLoopTool(runtime: ToolRuntime) {
  return defineTeamTool<LoopInput>(runtime, {
    name: "team_loop",
    description: "Increment the current phase retry counter and return remaining loops or an escalation.",
    input: objectSchema({
      run: { type: "string", description: "Optional run id." },
      reason: { type: "string", description: "Why this retry is needed." },
    }, ["reason"]),
    execute: async (raw, context) => {
      const input = readToolInput(raw);
      hasExplicitInputKeys(input, ["run", "reason"]);
      const runId = readOptionalString(input, "run");
      const reason = readRequiredString(input, "reason", { max: 2_000 });
      const services = requireServices(runtime);
      const identity = toolIdentity(context);
      touchSession(runtime, context);

      const resolved = resolveRun(runtime, runId, identity.sessionId);
      if (!resolved.ok) return failure(resolved.message, resolved.code);
      const run = resolved.run;
      touchSession(runtime, context, run.id);

      if (run.status !== "open") {
        return failure(`Run ${run.id} is ${run.status}; only an open run can loop.`, "run_not_open");
      }
      if (run.phase === "done") return failure(`Run ${run.id} is done and terminal.`, "run_terminal");

      const count = services.runs.incrementLoop(run.id, run.phase);
      const maxLoops = runtime.config.maxLoops;
      runtime.trace.event(
        "loop.incremented",
        { phase: run.phase, count, max_loops: maxLoops, reason },
        { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: run.phase },
      );

      if (count > maxLoops) {
        runtime.trace.event(
          "loop.exceeded",
          { phase: run.phase, count, max_loops: maxLoops, action: "ESCALATE_TO_HUMAN", reason },
          { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: run.phase },
        );
        return ok(
          {
            run: run.id,
            phase: run.phase,
            loop_count: count,
            max_loops: maxLoops,
            remaining: 0,
            escalate: true,
            action: "ESCALATE_TO_HUMAN",
          },
          `ESCALATE_TO_HUMAN: ${run.phase} has used ${count} attempts, exceeding maxLoops=${maxLoops}. Stop retrying and ask the human how to proceed.`,
        );
      }

      return ok(
        {
          run: run.id,
          phase: run.phase,
          loop_count: count,
          max_loops: maxLoops,
          remaining: Math.max(0, maxLoops - count),
          escalate: false,
        },
        `Loop ${count}/${maxLoops} for ${run.phase}; ${Math.max(0, maxLoops - count)} remaining.`,
      );
    },
  });
}
