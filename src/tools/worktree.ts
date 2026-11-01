import { createTeamWorktree, WorktreeError } from "../state/worktrees";
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
  ToolInputError,
  type ToolRuntime,
} from "./runtime";

interface WorktreeInput {
  readonly name: string;
  readonly run?: string;
}

export function createWorktreeTool(runtime: ToolRuntime) {
  return defineTeamTool<WorktreeInput>(runtime, {
    name: "team_worktree",
    description: "Create a named Git worktree for an open delivery run when worktrees are enabled.",
    input: objectSchema({
      name: { type: "string", description: "Unique task name matching ^[a-z0-9-]{1,40}$." },
      run: { type: "string", description: "Optional run id; defaults to the current session's run." },
    }, ["name"]),
    execute: async (raw, context) => {
      const input = readToolInput(raw);
      hasExplicitInputKeys(input, ["name", "run"]);
      const name = readRequiredString(input, "name", { max: 40 });
      const runId = readOptionalString(input, "run");
      if (!runtime.config.worktrees.enabled) {
        throw new ToolInputError("Worktrees are disabled; continue with sequential development in place.", "worktrees_disabled");
      }

      requireServices(runtime);
      const identity = toolIdentity(context);
      touchSession(runtime, context);
      const resolved = resolveRun(runtime, runId, identity.sessionId);
      if (!resolved.ok) return failure(resolved.message, resolved.code);
      const run = resolved.run;
      touchSession(runtime, context, run.id);
      if (run.status !== "open") {
        return failure(`Run ${run.id} is ${run.status}; only an open run can create a worktree.`, "run_not_open");
      }

      let created;
      try {
        created = createTeamWorktree({
          projectDir: runtime.config.projectDir,
          baseDir: runtime.config.worktrees.baseDir,
          run: run.id,
          name,
        });
      } catch (error) {
        if (error instanceof WorktreeError) throw new ToolInputError(error.message, error.code);
        throw error;
      }

      runtime.trace.event(
        "worktree.created",
        { path: created.path, branch: created.branch, name: created.name },
        {
          runId: run.id,
          sessionId: identity.sessionId,
          agent: identity.agent,
          toolCallId: identity.toolCallId,
          phase: run.phase,
        },
      );
      return ok(
        { run: run.id, name: created.name, path: created.path, branch: created.branch },
        `Created worktree for run ${run.id} at ${created.path} on ${created.branch}.`,
      );
    },
  });
}
