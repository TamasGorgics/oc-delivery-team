import { validatePhaseGate } from "../state/artifacts";
import { nextPhase } from "../state/phases";
import { writeRunReport } from "../state/report";
import { PromptRepository } from "../state/prompts";
import { StackService } from "../stack/service";
import { scanPromptProposals } from "../prompts/proposals";
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

interface AdvanceInput {
  readonly run?: string;
}

export function createAdvanceTool(runtime: ToolRuntime) {
  return defineTeamTool<AdvanceInput>(runtime, {
    name: "team_advance",
    description: "Validate the current phase gate and advance exactly one phase.",
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

      if (run.phase === "done") return failure(`Run ${run.id} is done and terminal.`, "run_terminal");
      if (run.status !== "open") {
        return failure(`Run ${run.id} is ${run.status}; only an open run can advance.`, "run_not_open");
      }
      const target = nextPhase(run.phase);
      if (!target) return failure(`Run ${run.id} has no next phase.`, "run_terminal");

      const profile = stackService(runtime).resolveForRun(run, false).profile;
      const notes = services.runs.listNotes(run.id);
      const gate = validatePhaseGate({
        phase: run.phase,
        rootDir: runtime.config.rootDir,
        runId: run.id,
        profile,
        notes,
      });

      if (!gate.ok) {
        runtime.trace.event(
          "gate.denied",
          { phase: run.phase, code: gate.code, message: gate.message, artifact: gate.artifact },
          { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: run.phase },
        );
        return failure(gate.message, "gate_denied", {
          phase: run.phase,
          gate: {
            ok: false,
            code: gate.code,
            artifact: gate.artifact,
            artifact_path: gate.artifactPath,
            footer: gate.footer?.values ?? {},
          },
        });
      }

      const now = new Date().toISOString();
      const startedAt = services.runs.getPhaseStartedAt(run.id);
      const durationMs = startedAt ? Math.max(0, Date.parse(now) - Date.parse(startedAt)) : null;

      services.db.transaction(() => {
        services.runs.addTransition({
          runId: run.id,
          from: run.phase,
          to: target,
          kind: "advance",
          at: now,
        });
        services.runs.updatePhase(run.id, target);
        if (target === "done") services.runs.closeRun(run.id, "closed");
      });

      runtime.trace.event(
        "phase.advanced",
        { from: run.phase, to: target, duration_ms: durationMs },
        { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: target },
      );

      if (run.phase === "retro") {
        try {
          const scanned = scanPromptProposals(
            runtime.config.rootDir,
            new PromptRepository(services.db),
            { sourceRun: run.id },
          );
          runtime.trace.event(
            "prompts.proposals_scanned",
            {
              directory: scanned.directory,
              count: scanned.registered.length,
              prompt_ids: scanned.registered.map((proposal) => proposal.id),
              skipped: scanned.skipped,
            },
            { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: run.phase },
          );
        } catch (error) {
          runtime.trace.event(
            "prompts.proposal_scan_error",
            { message: error instanceof Error ? error.message : String(error) },
            { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: run.phase },
          );
        }
      }

      let reportPath: string | undefined;
      if (target === "retro") {
        try {
          reportPath = writeRunReport(runtime.config.rootDir, {
            run: { ...run, phase: target },
            transitions: services.runs.getTransitions(run.id),
            loops: services.runs.getLoops(run.id),
            notes: services.runs.listNotes(run.id),
            events: services.runs.listEvents(run.id),
            toolCalls: services.runs.listToolCalls(run.id),
            messages: services.runs.listMessages(run.id),
            sessions: services.runs.listSessionsForRun(run.id),
            now,
          });
          runtime.trace.event(
            "report.generated",
            { path: reportPath },
            { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: target },
          );
        } catch (error) {
          runtime.trace.event(
            "report.error",
            { message: error instanceof Error ? error.message : String(error) },
            { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: target },
          );
        }
      }

      return ok(
        {
          run: run.id,
          from: run.phase,
          to: target,
          phase: target,
          duration_ms: durationMs,
          ...(reportPath ? { report_path: reportPath } : {}),
          terminal: target === "done",
        },
        target === "done"
          ? `Run ${run.id} advanced from ${run.phase} to done and is now closed.`
          : `Run ${run.id} advanced from ${run.phase} to ${target}.${reportPath ? ` Report: ${reportPath}` : ""}`,
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
