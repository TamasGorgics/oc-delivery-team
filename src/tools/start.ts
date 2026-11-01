import { ensureRunDirectory } from "../state/paths";
import { createRunId } from "../state/paths";
import type { RunModelInput } from "../state/runs";
import {
  defineTeamTool,
  hasExplicitInputKeys,
  objectSchema,
  ok,
  readRequiredString,
  readOptionalString,
  readToolInput,
  requireServices,
  toolIdentity,
  touchSession,
  type ToolRuntime,
} from "./runtime";

interface StartInput {
  readonly title: string;
  readonly description?: string;
}

export function createStartTool(runtime: ToolRuntime) {
  return defineTeamTool<StartInput>(runtime, {
    name: "team_start",
    description: "Start a delivery-team run for a goal and return its run id and artifact directory.",
    input: objectSchema({
      title: { type: "string", description: "Short run title or goal." },
      description: { type: "string", description: "Optional longer goal description." },
    }, ["title"]),
    execute: async (raw, context) => {
      const input = readToolInput(raw);
      hasExplicitInputKeys(input, ["title", "description"]);
      const title = readRequiredString(input, "title", { max: 200 });
      const description = readOptionalString(input, "description", { max: 4_000 });
      const services = requireServices(runtime);
      const identity = toolIdentity(context);
      touchSession(runtime, context);

      const timestamp = Date.now();
      let runId = createRunId(title, timestamp);
      for (let index = 1; services.runs.getRun(runId) && index < 100; index += 1) {
        runId = createRunId(title, timestamp + index);
      }
      if (services.runs.getRun(runId)) throw new Error("Could not allocate a unique run id.");

      const artifactDir = ensureRunDirectory(runtime.config.rootDir, runId);
      const routes = Object.values(runtime.modelSnapshot.roles)
        .filter((route) => route !== undefined)
        .map((route): RunModelInput => ({
          role: route.role,
          model: route.model,
          params: route.params,
          source: route.source,
        }));

      services.db.transaction(() => {
        services.runs.createRun({
          id: runId,
          title,
          ...(description ? { description } : {}),
          sessionId: identity.sessionId,
          projectDir: runtime.config.projectDir,
          phase: "brainstorm",
        });
        services.runs.addTransition({
          runId,
          from: null,
          to: "brainstorm",
          kind: "start",
          reason: "Run started.",
        });
        services.runs.bindSession(identity.sessionId, runId, identity.agent);
        services.runs.snapshotModels(runId, routes);
      });

      runtime.trace.event(
        "run.start",
        { title, artifact_dir: artifactDir },
        { runId, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: "brainstorm" },
      );
      for (const event of runtime.modelSnapshot.events) {
        runtime.trace.event(
          event.type,
          {
            ...(event.role ? { role: event.role } : {}),
            ...(event.model ? { model: event.model } : {}),
            reason: event.reason,
          },
          { runId, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId },
        );
      }

      return ok(
        {
          run: runId,
          title,
          phase: "brainstorm",
          artifact_dir: artifactDir,
          models: routes.length,
        },
        [
          `Started run ${runId} in brainstorm.`,
          `Artifacts: ${artifactDir}`,
          "Pass this exact artifact directory to every subagent; artifacts written outside it are blocked.",
          "Launch the researcher for brainstorm, then call team_advance when brainstorm.md exists.",
        ].join("\n"),
      );
    },
  });
}
