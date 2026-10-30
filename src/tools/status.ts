import { validatePhaseGate, type GateResult } from "../state/artifacts";
import { parseJsonRecord, type RunRow } from "../state/runs";
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
    description: "Show the current run phase, gate status, loops, notes, and recent events.",
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
      const profile = stackService(runtime).resolveForRun(run, false).profile;
      const gate = validatePhaseGate({
        phase: run.phase,
        rootDir: runtime.config.rootDir,
        runId: run.id,
        profile,
        notes,
      });
      const modelWarnings = events
        .filter((event) => event.kind.startsWith("model."))
        .map((event) => ({ kind: event.kind, data: parseJsonRecord(event.data_json) }));
      const loopSummary = loopCounts(loops);
      const nextAction = nextActionFor(run, gate);

      return ok(
        {
          run: run.id,
          title: run.title,
          status: run.status,
          phase: run.phase,
          gate: gatePayload(gate),
          loops: loopSummary,
          notes: notes.length,
          open_lessons: services.lessons.countOpen(),
          models: { warnings: modelWarnings },
          recent_events: events.map((event) => ({
            kind: event.kind,
            at: event.at,
            data: parseJsonRecord(event.data_json),
          })),
          next_action: nextAction,
        },
        renderStatus(run, gate, loopSummary, notes.length, services.lessons.countOpen(), nextAction),
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

function gatePayload(gate: GateResult): Record<string, unknown> {
  return {
    ok: gate.ok,
    code: gate.code,
    message: gate.message,
    artifact: gate.artifact,
    artifact_path: gate.artifactPath,
    ...(gate.footer ? { footer: gate.footer.values } : {}),
  };
}

function loopCounts(loops: readonly { readonly phase: string; readonly count: number }[]): Record<string, number> {
  return Object.fromEntries(loops.map((loop) => [loop.phase, Number(loop.count)]));
}

function nextActionFor(run: RunRow, gate: GateResult): string {
  if (run.status !== "open") return "The run is not open; inspect the status or start a new run.";
  if (run.phase === "done") return "The run is done and terminal.";
  if (gate.ok) return "Call team_advance to move to the next phase.";
  return gate.message;
}

function renderStatus(
  run: RunRow,
  gate: GateResult,
  loops: Record<string, number>,
  notes: number,
  openLessons: number,
  nextAction: string,
): string {
  const loopText = Object.keys(loops).length === 0
    ? "none"
    : Object.entries(loops).map(([phase, count]) => `${phase}=${count}`).join(", ");
  return [
    `Run ${run.id}: ${run.title}`,
    `Status: ${run.status}; phase: ${run.phase}`,
    `Gate: ${gate.ok ? "open" : `blocked (${gate.code})`} — ${gate.message}`,
    `Loops: ${loopText}; notes: ${notes}; open lessons: ${openLessons}.`,
    `Next: ${nextAction}`,
  ].join("\n");
}
