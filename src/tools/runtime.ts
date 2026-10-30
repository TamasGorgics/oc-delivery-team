import type { JsonSchema } from "effect";
import type { ToolContext, Info as ToolInfo, Result as ToolResult } from "@opencode/plugin/promise/tool";
import {
  defineTool,
  TEAM_TOOL_OUTPUT,
  toolContextIdentity,
  toolInputObject,
  toolResponse,
  type PluginContext,
} from "../compat";
import type { DeliveryTeamConfig } from "../config";
import type { ModelResolutionSnapshot } from "../models";
import type { TeamDatabase } from "../state/db";
import type { LessonsRepository } from "../state/lessons";
import { resolveSessionRun, type RunRow, type RunRepository } from "../state/runs";
import type { Tracer } from "../state/trace";

export interface ToolRuntime {
  readonly config: DeliveryTeamConfig;
  readonly db: TeamDatabase | null;
  readonly dbError?: string;
  readonly trace: Tracer;
  readonly runs: RunRepository | null;
  readonly lessons: LessonsRepository | null;
  readonly modelSnapshot: ModelResolutionSnapshot;
}

export interface CoreServices {
  readonly db: TeamDatabase;
  readonly runs: RunRepository;
  readonly lessons: LessonsRepository;
}

export class ToolInputError extends Error {
  constructor(message: string, readonly code = "invalid_input") {
    super(message);
    this.name = "ToolInputError";
  }
}

export interface TeamToolSpec<I> {
  readonly name: string;
  readonly description: string;
  readonly input: JsonSchema.JsonSchema;
  readonly execute: (input: I, context: ToolContext, runtime: ToolRuntime) => Promise<ToolResult>;
}

export function defineTeamTool<I>(runtime: ToolRuntime, spec: TeamToolSpec<I>): ToolInfo {
  return defineTool<I>({
    name: spec.name,
    description: spec.description,
    input: spec.input,
    output: TEAM_TOOL_OUTPUT,
    execute: async (raw, context) => {
      try {
        return await spec.execute(raw, context, runtime);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof ToolInputError ? error.code : "tool_error";
        const identity = toolContextIdentity(context);
        runtime.trace.event("tool.error", { tool: spec.name, code, message }, {
          sessionId: identity.sessionId,
          agent: identity.agent,
          toolCallId: identity.toolCallId,
        });
        return failure(message, code);
      }
    },
  });
}

export function services(runtime: ToolRuntime): CoreServices | undefined {
  if (!runtime.db || !runtime.runs || !runtime.lessons) return undefined;
  return { db: runtime.db, runs: runtime.runs, lessons: runtime.lessons };
}

export function requireServices(runtime: ToolRuntime): CoreServices {
  const value = services(runtime);
  if (!value) {
    throw new ToolInputError(
      runtime.dbError
        ? `The delivery-team database is unavailable: ${runtime.dbError}`
        : "The delivery-team database is unavailable.",
      "database_unavailable",
    );
  }
  return value;
}

export function ok(payload: Record<string, unknown>, text: string): ToolResult {
  return toolResponse({ ok: true, ...payload }, text);
}

export function failure(message: string, code = "tool_error", extra: Record<string, unknown> = {}): ToolResult {
  return toolResponse({ ok: false, code, error: message, ...extra }, message);
}

export function touchSession(
  runtime: ToolRuntime,
  context: ToolContext,
  runId?: string | null,
): void {
  const { runs } = requireServices(runtime);
  const identity = toolContextIdentity(context);
  runs.upsertSession({
    id: identity.sessionId,
    agent: identity.agent,
    ...(runId ? { runId } : {}),
  });
}

export type RunResolution =
  | { readonly ok: true; readonly run: RunRow }
  | { readonly ok: false; readonly message: string; readonly code: string };

export function resolveRun(
  runtime: ToolRuntime,
  explicitRun: string | undefined,
  sessionId: string,
): RunResolution {
  const { runs } = requireServices(runtime);

  if (explicitRun) {
    const run = runs.getRun(explicitRun);
    if (!run) return { ok: false, code: "run_not_found", message: `Run ${explicitRun} was not found.` };
    return { ok: true, run };
  }

  const resolution = resolveSessionRun(runs, sessionId);
  if (!resolution.ok) {
    return { ok: false, code: resolution.code, message: resolution.message };
  }

  const run = resolution.run;
  if (resolution.singleOpen) {
    const session = runs.getSession(sessionId);
    if (session && !session.run_id) runs.bindSession(sessionId, run.id, session.agent);
  }
  return { ok: true, run };
}

export function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): JsonSchema.JsonSchema {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  } as JsonSchema.JsonSchema;
}

export function readRequiredString(
  input: Record<string, unknown>,
  key: string,
  options: { readonly max?: number } = {},
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(`${key} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (options.max !== undefined && trimmed.length > options.max) {
    throw new ToolInputError(`${key} must be at most ${options.max} characters.`);
  }
  return trimmed;
}

export function readOptionalString(
  input: Record<string, unknown>,
  key: string,
  options: { readonly max?: number } = {},
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`${key} must be a string when provided.`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (options.max !== undefined && trimmed.length > options.max) {
    throw new ToolInputError(`${key} must be at most ${options.max} characters.`);
  }
  return trimmed;
}

export function readOptionalBoolean(input: Record<string, unknown>, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ToolInputError(`${key} must be a boolean when provided.`);
  return value;
}

export function readToolInput(input: unknown): Record<string, unknown> {
  return toolInputObject(input);
}

export type ToolIdentity = ReturnType<typeof toolContextIdentity>;

export function toolIdentity(context: ToolContext): ToolIdentity {
  return toolContextIdentity(context);
}

export function hasExplicitInputKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new ToolInputError(`Unknown input key(s): ${unknown.join(", ")}.`);
}

export async function registerTools(
  context: PluginContext,
  runtime: ToolRuntime,
): Promise<{ readonly dispose: () => Promise<void>; readonly names: readonly string[] }> {
  const { createTeamTools } = await import("./index");
  const tools = createTeamTools(runtime);
  const registration = await context.tool.transform((editor) => {
    for (const tool of tools) editor.add(tool);
  });
  await context.tool.reload();
  return {
    dispose: registration.dispose,
    names: tools.map((tool) => tool.name),
  };
}
