import { validatePhaseGate, type GateResult } from "../state/artifacts";
import { parseJsonRecord, type RunRow, type ToolCallRow } from "../state/runs";
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
          counters,
          notes: notes.length,
          open_lessons: services.lessons.countOpen(),
          models: { warnings: modelWarnings },
          recent_events: events.map((event) => ({
            kind: event.kind,
            at: event.at,
            data: parseJsonRecord(event.data_json),
          })),
          recent_tool_calls: recentToolCalls.map(toolCallPayload),
          next_action: nextAction,
        },
        renderStatus(run, gate, loopSummary, counters, notes.length, services.lessons.countOpen(), nextAction),
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
  counters: StatusCounters,
  notes: number,
  openLessons: number,
  nextAction: string,
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
    `Status: ${run.status}; phase: ${run.phase}`,
    `Gate: ${gate.ok ? "open" : `blocked (${gate.code})`} — ${gate.message}`,
    `Loops: ${loopText} (${counters.loops} total); notes: ${notes}; open lessons: ${openLessons}.`,
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
