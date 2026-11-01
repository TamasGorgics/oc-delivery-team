import { Model } from "@opencode/plugin";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Info as PromiseToolInfo, Result as PromiseToolResult, ToolContext } from "@opencode/plugin/promise/tool";
import type { Agent } from "@opencode/schema/agent";
import type { JsonSchema, Types } from "effect";
import { isRoleId, type RoleId } from "./roles";

export type PluginContext = Context;
export type AgentDraft = Types.DeepMutable<Agent.Info>;
export type ModelReference = ReturnType<typeof Model.Ref.parse>;
type ClientModel = Awaited<ReturnType<Context["model"]["list"]>>["data"][number];
type ClientProvider = Awaited<ReturnType<Context["provider"]["list"]>>["data"][number];

export interface CatalogModel {
  readonly providerID: string;
  readonly modelID: string;
  readonly reference: string;
  readonly enabled?: boolean;
  readonly tools?: boolean;
  readonly temperature?: boolean;
  readonly variants: readonly string[];
  readonly outputLimit?: number;
}

export interface CatalogProvider {
  readonly id: string;
  readonly activation?: ClientProvider["activation"];
}

export interface ModelCatalog {
  readonly models: readonly CatalogModel[];
  readonly providers: readonly CatalogProvider[];
  readonly defaultModel?: CatalogModel;
  readonly modelsAvailable: boolean;
  readonly providersAvailable: boolean;
  readonly defaultLookupSucceeded: boolean;
  readonly warnings: readonly string[];
}

export function pluginOptions(context: PluginContext): unknown {
  // The SDK declares PluginOptions with `any`; keep that loose boundary in this module.
  return context.options as unknown;
}

export function projectDirectory(context: PluginContext): string {
  return context.location.directory;
}

/**
 * The SDK exposes model/provider catalog reads as `{ location, data }` envelopes.
 * Keep those response shapes and their best-effort failure handling at this boundary.
 */
export async function readModelCatalog(context: PluginContext): Promise<ModelCatalog> {
  const warnings: string[] = [];

  const readModels = async (): Promise<{ available: boolean; models: CatalogModel[] }> => {
    try {
      const response = await context.model.list();
      return { available: true, models: response.data.map(toCatalogModel) };
    } catch (error) {
      warnings.push(`model.catalog_unavailable: ${errorMessage(error)}`);
      return { available: false, models: [] };
    }
  };

  const readProviders = async (): Promise<{ available: boolean; providers: CatalogProvider[] }> => {
    try {
      const response = await context.provider.list();
      return {
        available: true,
        providers: response.data.map((provider) => ({
          id: String(provider.id),
          activation: provider.activation,
        })),
      };
    } catch (error) {
      warnings.push(`provider.catalog_unavailable: ${errorMessage(error)}`);
      return { available: false, providers: [] };
    }
  };

  const readDefault = async (): Promise<{ succeeded: boolean; model?: CatalogModel }> => {
    try {
      const response = await context.model.default();
      return {
        succeeded: true,
        ...(response.data ? { model: toCatalogModel(response.data) } : {}),
      };
    } catch (error) {
      warnings.push(`model.default_unavailable: ${errorMessage(error)}`);
      return { succeeded: false };
    }
  };

  const [models, providers, defaultModel] = await Promise.all([
    readModels(),
    readProviders(),
    readDefault(),
  ]);

  return {
    models: models.models,
    providers: providers.providers,
    ...(defaultModel.model ? { defaultModel: defaultModel.model } : {}),
    modelsAvailable: models.available,
    providersAvailable: providers.available,
    defaultLookupSucceeded: defaultModel.succeeded,
    warnings,
  };
}

export function parseModelReference(reference: string): ModelReference {
  return Model.Ref.parse(reference);
}

export function formatModelReference(reference: ModelReference): string {
  return `${String(reference.providerID)}/${String(reference.id)}${reference.variant ? `#${String(reference.variant)}` : ""}`;
}

export function setAgentModel(draft: AgentDraft, reference: string | null): void {
  if (reference === null) {
    delete draft.model;
    return;
  }
  draft.model = parseModelReference(reference);
}

export function setAgentName(draft: AgentDraft, name: string): void {
  draft.name = name as AgentDraft["name"];
}

export function roleIdFromAgent(agent: unknown): RoleId | undefined {
  if (!isRoleId(agent)) return undefined;
  return String(agent) as RoleId;
}

const DEFAULT_PATH_KEYS: Readonly<Record<string, string>> = {
  edit: "path",
  write: "path",
};
const SHELL_TOOLS = new Set(["shell", "bash"]);

export interface EditedPathExtraction {
  readonly paths: readonly string[];
  readonly complete: boolean;
  readonly reason?: string;
}

/**
 * Extract every target path from an edit-like tool call. The installed host
 * uses `path` for edit/write and a Codex-style patch in `patchText`; an
 * optional `gating.pathKeys` map keeps the extractor adaptable to host changes.
 */
export function extractEditedPaths(
  tool: string,
  input: unknown,
  pathKeys: Readonly<Record<string, string>> = {},
): EditedPathExtraction {
  const record = toolInputObject(input);
  const override = pathKeys[tool]?.trim();

  if (tool === "patch" && !override) {
    const patchText = record.patchText;
    if (typeof patchText !== "string" || patchText.trim().length === 0) {
      return {
        paths: [],
        complete: false,
        reason: "patchText must contain *** Add File, *** Update File, or *** Delete File headers.",
      };
    }
    const paths = extractPatchPaths(patchText);
    return {
      paths,
      complete: paths.length > 0,
      ...(paths.length > 0
        ? {}
        : { reason: "No *** Add File, *** Update File, or *** Delete File path was found in patchText." }),
    };
  }

  const preferred = override ?? DEFAULT_PATH_KEYS[tool];
  if (preferred) {
    const value = record[preferred];
    if (typeof value === "string" && value.trim().length > 0) {
      return { paths: [value.trim()], complete: true };
    }
    if (override) {
      return { paths: [], complete: false, reason: `Input key '${preferred}' is missing or empty.` };
    }
  }

  return {
    paths: [],
    complete: false,
    reason: `No path input was found for '${tool}'. Use 'path' for edit/write, or configure gating.pathKeys for this tool.`,
  };
}

export function extractPatchPaths(patchText: string): string[] {
  const paths: string[] = [];
  const header = /^\s*\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm;
  const move = /^\s*\*\*\* Move to:\s*(.+?)\s*$/gm;
  for (const match of patchText.matchAll(header)) {
    const value = match[1]?.trim();
    if (value) paths.push(value);
  }
  for (const match of patchText.matchAll(move)) {
    const value = match[1]?.trim();
    if (value) paths.push(value);
  }
  return [...new Set(paths)];
}

export function isShellTool(tool: string): boolean {
  return SHELL_TOOLS.has(tool);
}

export function extractShellCommand(tool: string, input: unknown): string | undefined {
  if (!isShellTool(tool)) return undefined;
  const record = toolInputObject(input);
  for (const key of ["command", "cmd"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/**
 * AgentEditor has no `add` method. M0 verified that `update` creates a missing
 * agent in the installed host, so all agent upserts go through this adapter.
 */
export function upsertAgent(
  editor: AgentEditor,
  id: string,
  update: (draft: AgentDraft) => void,
): void {
  editor.update(id, update);
}

/**
 * Tool definitions use plain JSON Schema so `additionalProperties: false` is
 * explicit. The SDK's generic input/output inference is intentionally kept at
 * this boundary; executors receive the validated object as their typed input.
 */
export interface ToolSpec<I> {
  readonly name: string;
  readonly description: string;
  readonly input: JsonSchema.JsonSchema;
  readonly output?: JsonSchema.JsonSchema;
  readonly execute: (input: I, context: ToolContext) => Promise<PromiseToolResult>;
}

/** Every team tool returns a structured object with an `ok` discriminator. */
export const TEAM_TOOL_OUTPUT: JsonSchema.JsonSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: true,
};

export function defineTool<I>(spec: ToolSpec<I>): PromiseToolInfo {
  return spec as unknown as PromiseToolInfo;
}

export function toolResponse(
  payload: Record<string, unknown>,
  text: string,
): PromiseToolResult {
  return {
    output: payload,
    content: [{ type: "text", text }],
  };
}

export function toolInputObject(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

export interface TextSystemPart {
  readonly type: "text";
  readonly text: string;
}

export type SystemAppendResult =
  | { readonly ok: true; readonly system: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * Session context hooks expose `system` as an array of text parts in the
 * installed host, but the SPEC requires string and structured compatibility.
 * This adapter mutates arrays in place, returns a replacement string for string
 * systems, and refuses unknown shapes so the caller can skip safely.
 */
export function appendSystemSection(system: unknown, section: string): SystemAppendResult {
  const text = section.trim();
  if (!text) return { ok: true, system };

  if (typeof system === "string") {
    if (system.includes(text)) return { ok: true, system };
    return { ok: true, system: system ? `${system}\n\n${text}` : text };
  }

  if (Array.isArray(system)) {
    if (system.some((part) => systemPartText(part)?.includes(text))) {
      return { ok: true, system };
    }
    system.push({ type: "text", text: system.length > 0 ? `\n\n${text}` : text });
    return { ok: true, system };
  }

  if (isTextSystemPart(system)) {
    if (system.text.includes(text)) return { ok: true, system };
    return {
      ok: true,
      system: [system, { type: "text", text: `\n\n${text}` }],
    };
  }

  if (system === undefined || system === null) {
    return { ok: true, system: [{ type: "text", text }] };
  }

  return {
    ok: false,
    reason: "system must be a string, a text part, or an array of text parts.",
  };
}

function isTextSystemPart(value: unknown): value is TextSystemPart {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "text"
    && typeof (value as Record<string, unknown>).text === "string";
}

function systemPartText(value: unknown): string | undefined {
  return isTextSystemPart(value) ? value.text : undefined;
}

export function toolContextIdentity(context: ToolContext): {
  readonly sessionId: string;
  readonly agent: string;
  readonly toolCallId: string;
} {
  return {
    sessionId: String(context.sessionID),
    agent: String(context.agent),
    toolCallId: String(context.id),
  };
}

function toCatalogModel(model: ClientModel): CatalogModel {
  return {
    providerID: String(model.providerID),
    modelID: String(model.modelID),
    reference: `${String(model.providerID)}/${String(model.modelID)}`,
    enabled: model.enabled,
    tools: model.capabilities?.tools,
    temperature: model.capabilities?.temperature,
    variants: Array.isArray(model.variants) ? model.variants.map((variant) => String(variant.id)) : [],
    outputLimit: Number.isFinite(model.limit?.output) ? model.limit.output : undefined,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
