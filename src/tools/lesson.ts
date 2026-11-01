import {
  DUPLICATE_SIMILARITY_THRESHOLD,
  MAX_LESSONS_PER_RUN,
  MAX_LESSON_CHARS,
  MIN_LESSON_CHARS,
  isLessonRole,
  normalizeLessonStack,
  validateLessonText,
  type LessonRole,
} from "../state/lessons";
import { ROLE_IDS } from "../roles";
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

interface LessonInput {
  readonly run?: string;
  readonly role: LessonRole;
  readonly text: string;
  readonly evidence?: string;
  readonly stack?: string;
}

export function createLessonTool(runtime: ToolRuntime) {
  return defineTeamTool<LessonInput>(runtime, {
    name: "team_lesson_propose",
    description: "Propose a role-scoped lesson for human approval. Proposed lessons are never injected.",
    input: objectSchema({
      run: { type: "string", description: "Optional run id." },
      role: {
        type: "string",
        enum: [...ROLE_IDS, "*"],
        description: "Role that should learn this lesson, or * for every role.",
      },
      text: {
        type: "string",
        minLength: MIN_LESSON_CHARS,
        maxLength: MAX_LESSON_CHARS,
        description: "A short, imperative, single-sentence lesson.",
      },
      evidence: { type: "string", description: "Optional supporting evidence from the run." },
      stack: {
        type: "string",
        description: "Optional language tag from the Stack Profile; defaults to *.",
      },
    }, ["role", "text"]),
    execute: async (raw, context) => {
      const input = readToolInput(raw);
      hasExplicitInputKeys(input, ["run", "role", "text", "evidence", "stack"]);
      const runId = readOptionalString(input, "run");

      if (typeof input.role !== "string" || !isLessonRole(input.role.trim())) {
        return failure(
          `role must be one of ${ROLE_IDS.join(", ")}, or *.`,
          "invalid_input",
        );
      }
      const role = input.role.trim() as LessonRole;

      if (typeof input.text !== "string") {
        return failure("text must be a non-empty string.", "invalid_input");
      }
      const validatedText = validateLessonText(input.text);
      if (!validatedText.ok) return failure(validatedText.message, "invalid_lesson");
      const text = validatedText.text;

      const evidence = readOptionalString(input, "evidence", { max: 2_000 });
      if (input.stack !== undefined && typeof input.stack !== "string") {
        return failure("stack must be a string when provided.", "invalid_input");
      }
      const stackTag = normalizeLessonStack(input.stack);
      if (!stackTag) {
        return failure(
          "stack must be * or a short lower-case language tag such as typescript or python.",
          "invalid_input",
        );
      }

      const services = requireServices(runtime);
      const identity = toolIdentity(context);
      touchSession(runtime, context);

      const resolved = resolveRun(runtime, runId, identity.sessionId);
      if (!resolved.ok) return failure(resolved.message, resolved.code);
      const run = resolved.run;
      touchSession(runtime, context, run.id);

      const existing = services.lessons.findDuplicate(role, text);
      if (existing) {
        runtime.trace.event(
          "lesson.duplicate",
          {
            role,
            existing_id: existing.id,
            existing_status: existing.status,
            similarity_threshold: DUPLICATE_SIMILARITY_THRESHOLD,
          },
          {
            runId: run.id,
            sessionId: identity.sessionId,
            agent: identity.agent,
            toolCallId: identity.toolCallId,
            phase: run.phase,
          },
        );
        return failure(
          `Lesson ${existing.id} already covers this guidance. Use the existing lesson or make the new proposal materially different.`,
          "duplicate_lesson",
          { existing_id: existing.id, existing_status: existing.status },
        );
      }

      const proposalCount = services.lessons.countForRun(run.id);
      if (proposalCount >= MAX_LESSONS_PER_RUN) {
        return failure(
          `Run ${run.id} already has ${MAX_LESSONS_PER_RUN} lesson proposals; the per-run proposal cap has been reached.`,
          "proposal_cap_reached",
          { run: run.id, cap: MAX_LESSONS_PER_RUN },
        );
      }

      const id = services.lessons.insert({
        role,
        text,
        ...(evidence ? { evidence } : {}),
        sourceRun: run.id,
        stackTag,
      });
      runtime.trace.event(
        "lesson.proposed",
        { lesson_id: id, role, stack_tag: stackTag, proposal_count: proposalCount + 1 },
        {
          runId: run.id,
          sessionId: identity.sessionId,
          agent: identity.agent,
          toolCallId: identity.toolCallId,
          phase: run.phase,
        },
      );

      return ok(
        {
          run: run.id,
          lesson_id: id,
          role,
          stack_tag: stackTag,
          status: "proposed",
        },
        [
          `Proposed lesson ${id} for ${role} (stack: ${stackTag}) on run ${run.id}.`,
          "A human must approve it with the team CLI before it can be injected.",
        ].join(" "),
      );
    },
  });
}
