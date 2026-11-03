import { isReviewRole, type ReviewRole } from "../state/reviews";
import {
  ToolInputError,
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
  readonly role?: ReviewRole;
}

type RoleResolution =
  | { readonly ok: true; readonly role: string }
  | { readonly ok: false; readonly message: string; readonly code: string };

export function createLoopTool(runtime: ToolRuntime) {
  return defineTeamTool<LoopInput>(runtime, {
    name: "team_loop",
    description: "Increment the current phase retry counter and return remaining loops or an escalation.",
    input: objectSchema({
      run: { type: "string", description: "Optional run id." },
      reason: { type: "string", description: "Why this retry is needed." },
      role: {
        type: "string",
        enum: ["qa", "adversary"],
        description: "Optional reviewer role inside an enabled parallel review wave.",
      },
    }, ["reason"]),
    execute: async (raw, context) => {
      const input = readToolInput(raw);
      hasExplicitInputKeys(input, ["run", "reason", "role"]);
      const runId = readOptionalString(input, "run");
      const reason = readRequiredString(input, "reason", { max: 2_000 });
      const suppliedRole = readOptionalString(input, "role");
      if (suppliedRole !== undefined && !isReviewRole(suppliedRole)) {
        throw new ToolInputError('role must be "qa" or "adversary" when provided.');
      }
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

      const role = resolveRole(runtime, run.phase, identity.agent, suppliedRole);
      if (!role.ok) return failure(role.message, role.code);

      const count = services.runs.incrementLoop(run.id, run.phase, role.role);
      const maxLoops = runtime.config.maxLoops;
      const rolePayload = role.role ? { role: role.role } : {};
      runtime.trace.event(
        "loop.incremented",
        { phase: run.phase, count, max_loops: maxLoops, reason, ...rolePayload },
        { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: run.phase },
      );

      if (count > maxLoops) {
        runtime.trace.event(
          "loop.exceeded",
          { phase: run.phase, count, max_loops: maxLoops, action: "ESCALATE_TO_HUMAN", reason, ...rolePayload },
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
            ...rolePayload,
          },
          role.role
            ? `ESCALATE_TO_HUMAN: ${run.phase} review role ${role.role} has used ${count} attempts, exceeding maxLoops=${maxLoops}. Stop retrying and ask the human how to proceed.`
            : `ESCALATE_TO_HUMAN: ${run.phase} has used ${count} attempts, exceeding maxLoops=${maxLoops}. Stop retrying and ask the human how to proceed.`,
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
          ...rolePayload,
        },
        role.role
          ? `Loop ${count}/${maxLoops} for ${run.phase} review role ${role.role}; ${Math.max(0, maxLoops - count)} remaining.`
          : `Loop ${count}/${maxLoops} for ${run.phase}; ${Math.max(0, maxLoops - count)} remaining.`,
      );
    },
  });
}

/**
 * Resolve the loop counter key per spec §6.4. Rejections return before any
 * increment, so a bad role never charges a counter.
 */
function resolveRole(
  runtime: ToolRuntime,
  phase: string,
  agent: string,
  suppliedRole: ReviewRole | undefined,
): RoleResolution {
  const enabled = runtime.config.reviews.parallel;
  if (suppliedRole !== undefined && !enabled) {
    return {
      ok: false,
      code: "review_role_not_enabled",
      message: "Review role counters require the parallel review wave; enable reviews.parallel in the plugin config.",
    };
  }
  if (suppliedRole !== undefined && phase !== "qa") {
    return {
      ok: false,
      code: "review_role_out_of_phase",
      message: `Review role counters apply only in qa; the run is in ${phase}.`,
    };
  }

  if (!enabled || phase !== "qa") return { ok: true, role: "" };

  const reviewerRole = isReviewRole(agent) ? agent : undefined;
  if (reviewerRole) {
    if (suppliedRole !== undefined && suppliedRole !== reviewerRole) {
      return {
        ok: false,
        code: "review_role_mismatch",
        message: `The ${agent} reviewer can only increment role "${reviewerRole}", not "${suppliedRole}".`,
      };
    }
    return { ok: true, role: reviewerRole };
  }

  if (suppliedRole === undefined) {
    return {
      ok: false,
      code: "review_role_required",
      message: 'Pass role="qa" or role="adversary" from a non-reviewer session while the review wave is active.',
    };
  }
  return { ok: true, role: suppliedRole };
}
