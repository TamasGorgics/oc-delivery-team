import { Model } from "@opencode/plugin";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Agent } from "@opencode/schema/agent";
import type { Types } from "effect";
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
