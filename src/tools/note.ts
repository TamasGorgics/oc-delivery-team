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

const NOTE_KINDS = ["decision", "finding", "risk", "question"] as const;
type NoteKind = (typeof NOTE_KINDS)[number];

interface NoteInput {
  readonly run?: string;
  readonly kind: NoteKind;
  readonly text: string;
}

export function createNoteTool(runtime: ToolRuntime) {
  return defineTeamTool<NoteInput>(runtime, {
    name: "team_note",
    description: "Append a decision, finding, risk, or question to the current run.",
    input: objectSchema({
      run: { type: "string", description: "Optional run id." },
      kind: { type: "string", enum: [...NOTE_KINDS] },
      text: { type: "string", description: "Note text." },
    }, ["kind", "text"]),
    execute: async (raw, context) => {
      const input = readToolInput(raw);
      hasExplicitInputKeys(input, ["run", "kind", "text"]);
      const runId = readOptionalString(input, "run");
      if (typeof input.kind !== "string" || !(NOTE_KINDS as readonly string[]).includes(input.kind)) {
        return failure(`kind must be one of ${NOTE_KINDS.join(", ")}.`, "invalid_input");
      }
      const kind = input.kind as NoteKind;
      const text = readRequiredString(input, "text", { max: 4_000 });
      const services = requireServices(runtime);
      const identity = toolIdentity(context);
      touchSession(runtime, context);

      const resolved = resolveRun(runtime, runId, identity.sessionId);
      if (!resolved.ok) return failure(resolved.message, resolved.code);
      const run = resolved.run;
      touchSession(runtime, context, run.id);

      const id = services.runs.addNote({
        runId: run.id,
        kind,
        text,
        agent: identity.agent,
        sessionId: identity.sessionId,
      });
      runtime.trace.event(
        "note.added",
        { note_id: id, kind, text },
        { runId: run.id, sessionId: identity.sessionId, agent: identity.agent, toolCallId: identity.toolCallId, phase: run.phase },
      );

      return ok(
        { run: run.id, note_id: id, kind, phase: run.phase },
        `Recorded ${kind} note ${id} on run ${run.id}.`,
      );
    },
  });
}
