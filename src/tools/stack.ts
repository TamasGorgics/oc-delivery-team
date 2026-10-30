import { resolveScopeGlobs, type StackProfile } from "../stack/profile";
import { StackService } from "../stack/service";
import { isRecord } from "../config";
import {
  defineTeamTool,
  failure,
  hasExplicitInputKeys,
  objectSchema,
  ok,
  readOptionalBoolean,
  readOptionalString,
  readToolInput,
  requireServices,
  resolveRun,
  toolIdentity,
  touchSession,
  type ToolRuntime,
} from "./runtime";
import type { RunRow } from "../state/runs";

interface StackInput {
  readonly run?: string;
  readonly refresh?: boolean;
}

interface StackUpdateInput {
  readonly run?: string;
  readonly patch: Record<string, unknown>;
}

export function createStackTools(runtime: ToolRuntime) {
  return [
    createStackTool(runtime),
    createStackUpdateTool(runtime),
  ];
}

function createStackTool(runtime: ToolRuntime) {
  return defineTeamTool<StackInput>(runtime, {
    name: "team_stack",
    description: "Return the Stack Profile for the current run, detecting it when none is stored.",
    input: objectSchema({
      run: { type: "string", description: "Optional run id." },
      refresh: { type: "boolean", description: "Re-detect and overwrite the stored profile." },
    }),
    execute: async (raw, context) => {
      const input = readToolInput(raw);
      hasExplicitInputKeys(input, ["run", "refresh"]);
      const runId = readOptionalString(input, "run");
      const refresh = readOptionalBoolean(input, "refresh") ?? false;
      requireServices(runtime);
      touchSession(runtime, context);

      let run: RunRow | undefined;
      if (runId) {
        const resolved = resolveRun(runtime, runId, toolIdentity(context).sessionId);
        if (!resolved.ok) return failure(resolved.message, resolved.code);
        run = resolved.run;
      } else {
        const resolved = resolveRun(runtime, undefined, toolIdentity(context).sessionId);
        if (resolved.ok) {
          run = resolved.run;
        } else if (resolved.code === "run_ambiguous") {
          return failure(resolved.message, resolved.code);
        }
      }

      const service = stackService(runtime);
      const resolution = run ? service.resolveForRun(run, refresh) : service.resolveForProject();
      if (run) service.persist(run, resolution.profile);

      const identity = toolIdentity(context);
      const traceIdentity = {
        ...(run ? { runId: run.id } : {}),
        sessionId: identity.sessionId,
        agent: identity.agent,
        toolCallId: identity.toolCallId,
        phase: run?.phase,
      };
      runtime.trace.event(
        "stack.resolved",
        {
          layer: resolution.layer,
          sources: resolution.sources,
          refresh,
          persisted: Boolean(run),
          diagnostics: resolution.diagnostics,
        },
        traceIdentity,
      );
      if (resolution.globsDefaulted) {
        const globs = resolveScopeGlobs(resolution.profile);
        runtime.trace.event(
          "gate.scope_default",
          { tests: globs.tests, docs: globs.docs, profile_source: resolution.profile.source },
          traceIdentity,
        );
      }

      return ok(
        {
          run: run?.id ?? null,
          profile: resolution.profile,
          layer: resolution.layer,
          sources: resolution.sources,
          globs_defaulted: resolution.globsDefaulted,
          diagnostics: resolution.diagnostics,
          persisted: Boolean(run),
        },
        renderStackText(run, resolution.profile, resolution.layer, resolution.sources),
      );
    },
  });
}

function createStackUpdateTool(runtime: ToolRuntime) {
  return defineTeamTool<StackUpdateInput>(runtime, {
    name: "team_stack_update",
    description: "Validate and merge a patch into the current run's Stack Profile.",
    input: objectSchema({
      run: { type: "string", description: "Optional run id." },
      patch: { type: "object", description: "JSON merge patch for the Stack Profile." },
    }, ["patch"]),
    execute: async (raw, context) => {
      const input = readToolInput(raw);
      hasExplicitInputKeys(input, ["run", "patch"]);
      const runId = readOptionalString(input, "run");
      if (!isRecord(input.patch)) return failure("patch must be an object.", "invalid_input");
      const identity = toolIdentity(context);
      requireServices(runtime);
      touchSession(runtime, context);

      const resolved = resolveRun(runtime, runId, identity.sessionId);
      if (!resolved.ok) return failure(resolved.message, resolved.code);

      const service = stackService(runtime);
      const update = service.updateRun(resolved.run, input.patch);
      if (!update.ok || !update.profile) {
        runtime.trace.event(
          "stack.update_denied",
          { error: update.error, conflicts: update.conflicts, diagnostics: update.diagnostics },
          { runId: resolved.run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId },
        );
        return failure(
          update.error ?? "The stack patch was denied.",
          update.conflicts && update.conflicts.length > 0 ? "human_owned_field" : "invalid_input",
          { conflicts: update.conflicts ?? [], diagnostics: update.diagnostics },
        );
      }

      runtime.trace.event(
        "stack.updated",
        { patch: input.patch },
        { runId: resolved.run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId },
      );
      return ok(
        {
          run: resolved.run.id,
          profile: update.profile,
          layer: "run",
          sources: ["run"],
          diagnostics: update.diagnostics,
        },
        `Updated the Stack Profile for run ${resolved.run.id}.`,
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

function renderStackText(
  run: RunRow | undefined,
  profile: StackProfile,
  layer: string,
  sources: readonly string[],
): string {
  const components = profile.components.length === 0
    ? "No components detected."
    : profile.components.map((component) => `${component.name} (${component.languages.join(", ") || "no language"}) at ${component.root}`).join("\n");
  return [
    run ? `Stack Profile for run ${run.id}.` : "Project Stack Profile.",
    `Layer: ${layer}; sources: ${sources.join(" -> ")}.`,
    components,
    profile.notes ? `Notes: ${profile.notes}` : "",
  ].filter(Boolean).join("\n");
}
