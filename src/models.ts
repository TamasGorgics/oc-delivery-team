import {
  formatModelReference,
  parseModelReference,
  type CatalogModel,
  type ModelCatalog,
  type ModelReference,
} from "./compat";
import type { ModelsConfig } from "./config";
import { enabledRoles, type ModelTier, type RoleId } from "./roles";

export type ModelResolutionSource = "role" | "tier" | "default" | "inherit" | "fallback";

export type ModelEventType =
  | "model.fallback"
  | "model.diversity_warning"
  | "model.param_unsupported"
  | "model.validation_skipped"
  | "model.catalog_unavailable"
  | "model.auto_unsupported";

export interface ModelResolutionEvent {
  readonly type: ModelEventType;
  readonly role?: RoleId;
  readonly model?: string;
  readonly reason: string;
}

export interface RequestModelOptions {
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
}

export interface RoleModelResolution {
  readonly role: RoleId;
  readonly tier: ModelTier;
  /** NULL means the agent inherits the host's default model. */
  readonly model: string | null;
  /** Effective model used only for validation and diversity comparisons. */
  readonly effectiveModel: string | null;
  readonly source: ModelResolutionSource;
  readonly params: Readonly<Record<string, unknown>>;
  readonly steps?: number;
  readonly requestOptions: RequestModelOptions;
}

export interface ModelResolutionSnapshot {
  readonly roles: Readonly<Partial<Record<RoleId, RoleModelResolution>>>;
  readonly events: readonly ModelResolutionEvent[];
}

export interface ModelResolution {
  readonly routes: Readonly<Partial<Record<RoleId, RoleModelResolution>>>;
  readonly snapshot: ModelResolutionSnapshot;
}

interface ModelCandidateSource {
  readonly source: Exclude<ModelResolutionSource, "inherit" | "fallback">;
  readonly spec: NonNullable<ModelsConfig["default"]>;
}

interface ValidatedCandidate {
  readonly reference: ModelReference;
  readonly formatted: string;
  readonly model?: CatalogModel;
}

interface ModelValidation {
  readonly candidate?: ValidatedCandidate;
  readonly reason?: string;
  readonly skipped?: boolean;
}

const TIER_DEFAULT_PARAMS: Readonly<Record<ModelTier, Readonly<Record<string, unknown>>>> = {
  reasoning: { reasoningEffort: "high" },
  coding: { reasoningEffort: "medium" },
  fast: {},
};

const SUPPORTED_PARAMS = new Set([
  "temperature",
  "topP",
  "reasoningEffort",
  "maxSteps",
  "maxOutputTokens",
]);

export function resolveModels(
  config: ModelsConfig,
  catalog: ModelCatalog,
  disabled: readonly RoleId[] = [],
): ModelResolution {
  const events: ModelResolutionEvent[] = catalog.warnings.map((reason) => ({
    type: "model.catalog_unavailable",
    reason,
  }));
  const routes: Partial<Record<RoleId, RoleModelResolution>> = {};

  if (config.auto) {
    events.push({
      type: "model.auto_unsupported",
      reason: "Automatic model assignment is deferred; configured routes are used and unresolved roles inherit.",
    });
  }

  for (const role of enabledRoles(disabled)) {
    const tier = config.roleTier[role.id] ?? role.tier;
    const candidates = candidateSources(config, role.id, tier);
    let selected: {
      readonly reference: string;
      readonly source: ModelResolutionSource;
      readonly params: Record<string, unknown>;
      readonly model?: CatalogModel;
    } | undefined;

    for (const source of candidates) {
      const params = mergedParams(config, role.id, tier, source.spec);
      const validation = validateModel(source.spec.model, catalog);
      if (validation.candidate) {
        addValidationSkippedEvents(role.id, source.spec.model, validation, catalog, events);
        selected = {
          reference: validation.candidate.formatted,
          source: source.source,
          params,
          ...(validation.candidate.model ? { model: validation.candidate.model } : {}),
        };
        break;
      }

      events.push({
        type: "model.fallback",
        role: role.id,
        model: source.spec.model,
        reason: validation.reason ?? "Model could not be validated.",
      });

      for (const fallback of source.spec.fallback ?? []) {
        const fallbackValidation = validateModel(fallback, catalog);
        if (fallbackValidation.candidate) {
          addValidationSkippedEvents(role.id, fallback, fallbackValidation, catalog, events);
          selected = {
            reference: fallbackValidation.candidate.formatted,
            source: "fallback",
            params,
            ...(fallbackValidation.candidate.model ? { model: fallbackValidation.candidate.model } : {}),
          };
          break;
        }

        events.push({
          type: "model.fallback",
          role: role.id,
          model: fallback,
          reason: fallbackValidation.reason ?? "Fallback model could not be validated.",
        });
      }

      if (selected) break;
    }

    const inherit = selected === undefined;
    const initialEffectiveReference = selected?.reference ?? catalog.defaultModel?.reference ?? null;
    const metadata = selected?.model ?? findCatalogModel(initialEffectiveReference, catalog);
    const rawParams = selected?.params ?? mergedParams(config, role.id, tier);
    const normalized = normalizeParams(
      role.id,
      rawParams,
      metadata,
      initialEffectiveReference,
      !inherit,
      events,
    );
    const effectiveReference = normalized.reference ?? initialEffectiveReference;
    const steps = normalized.params.maxSteps === undefined
      ? role.maxSteps
      : normalized.params.maxSteps as number;
    const snapshotParams: Record<string, unknown> = { ...normalized.params };
    if (steps !== undefined) snapshotParams.maxSteps = steps;

    routes[role.id] = {
      role: role.id,
      tier,
      model: inherit ? null : effectiveReference,
      effectiveModel: effectiveReference,
      source: selected?.source ?? "inherit",
      params: snapshotParams,
      ...(steps !== undefined ? { steps } : {}),
      requestOptions: normalized.requestOptions,
    };
  }

  addDiversityWarning(config, routes, events);

  return {
    routes,
    snapshot: {
      roles: routes,
      events,
    },
  };
}

function candidateSources(
  config: ModelsConfig,
  role: RoleId,
  tier: ModelTier,
): ModelCandidateSource[] {
  const result: ModelCandidateSource[] = [];
  const roleSpec = config.roles[role];
  const tierSpec = config.tiers[tier];

  if (roleSpec) result.push({ source: "role", spec: roleSpec });
  if (tierSpec) result.push({ source: "tier", spec: tierSpec });
  if (config.default) result.push({ source: "default", spec: config.default });
  return result;
}

function mergedParams(
  config: ModelsConfig,
  role: RoleId,
  tier: ModelTier,
  spec?: NonNullable<ModelsConfig["default"]>,
): Record<string, unknown> {
  return {
    ...TIER_DEFAULT_PARAMS[tier],
    ...(spec?.params ?? {}),
    ...(config.params[role] ?? {}),
  };
}

function validateModel(reference: string, catalog: ModelCatalog): ModelValidation {
  let parsed: ModelReference;
  try {
    parsed = parseModelReference(reference);
  } catch (error) {
    return { reason: `Invalid model reference: ${errorMessage(error)}` };
  }

  const providerID = String(parsed.providerID);
  const modelID = String(parsed.id);
  const canonical = formatModelReference(parsed);

  if (catalog.providersAvailable) {
    const provider = catalog.providers.find((entry) => entry.id === providerID);
    if (!provider) {
      return { reason: `Provider '${providerID}' is not connected or available in the provider catalog.` };
    }
    if (provider.activation === "disabled") {
      return { reason: `Provider '${providerID}' is disabled.` };
    }
  }

  if (!catalog.modelsAvailable) {
    return {
      candidate: { reference: parsed, formatted: canonical },
      skipped: true,
    };
  }

  const model = catalog.models.find((entry) => entry.providerID === providerID && entry.modelID === modelID);
  if (!model) {
    return { reason: `Model '${providerID}/${modelID}' is missing from the available model catalog.` };
  }
  if (model.enabled === false) {
    return { reason: `Model '${providerID}/${modelID}' is not enabled.` };
  }
  if (model.tools === false) {
    return { reason: `Model '${providerID}/${modelID}' does not support tool calling.` };
  }
  if (parsed.variant && !model.variants.includes(String(parsed.variant))) {
    return {
      reason: `Variant '${String(parsed.variant)}' is not available for model '${providerID}/${modelID}'.`,
    };
  }

  return { candidate: { reference: parsed, formatted: canonical, model } };
}

function normalizeParams(
  role: RoleId,
  raw: Record<string, unknown>,
  model: CatalogModel | undefined,
  reference: string | null,
  mayApplyVariant: boolean,
  events: ModelResolutionEvent[],
): { params: Record<string, unknown>; requestOptions: RequestModelOptions; reference: string | null } {
  const params: Record<string, unknown> = {};
  const requestOptions: { temperature?: number; topP?: number; maxTokens?: number } = {};
  let effectiveReference = reference;

  for (const [key, value] of Object.entries(raw)) {
    if (!SUPPORTED_PARAMS.has(key)) {
      events.push({
        type: "model.param_unsupported",
        role,
        ...(reference ? { model: reference } : {}),
        reason: `Unknown model parameter '${key}' was ignored.`,
      });
      continue;
    }

    if (key === "maxSteps") {
      if (!isPositiveInteger(value)) {
        unsupportedParam(events, role, reference, key, "must be a positive integer");
        continue;
      }
      params.maxSteps = value;
      continue;
    }

    if (key === "temperature") {
      if (!isNonNegativeFinite(value)) {
        unsupportedParam(events, role, reference, key, "must be a finite non-negative number");
        continue;
      }
      if (model?.temperature === false) {
        unsupportedParam(events, role, reference, key, "the selected model does not support temperature");
        continue;
      }
      params.temperature = value;
      requestOptions.temperature = value;
      continue;
    }

    if (key === "topP") {
      if (!isUnitInterval(value)) {
        unsupportedParam(events, role, reference, key, "must be a number between 0 and 1");
        continue;
      }
      params.topP = value;
      requestOptions.topP = value;
      continue;
    }

    if (key === "maxOutputTokens") {
      if (!isPositiveInteger(value)) {
        unsupportedParam(events, role, reference, key, "must be a positive integer");
        continue;
      }
      params.maxOutputTokens = value;
      requestOptions.maxTokens = value;
      continue;
    }

    if (key === "reasoningEffort") {
      if (typeof value !== "string" || value.trim().length === 0) {
        unsupportedParam(events, role, reference, key, "must be a non-empty variant name");
        continue;
      }
      const requested = value.trim();
      const currentVariant = reference ? safeVariant(reference) : undefined;
      if (currentVariant) {
        if (currentVariant !== requested) {
          unsupportedParam(
            events,
            role,
            reference,
            key,
            `the model reference already selects variant '${currentVariant}'`,
          );
        } else {
          params.reasoningEffort = requested;
        }
        continue;
      }
      if (!mayApplyVariant) {
        unsupportedParam(
          events,
          role,
          reference,
          key,
          "a reasoning variant cannot be applied while inheriting the host model",
        );
        continue;
      }
      if (!model || !model.variants.includes(requested)) {
        unsupportedParam(events, role, reference, key, `variant '${requested}' is not available`);
        continue;
      }
      params.reasoningEffort = requested;
      if (reference) effectiveReference = `${stripVariant(reference)}#${requested}`;
      continue;
    }
  }

  return { params, requestOptions, reference: effectiveReference };
}

function addValidationSkippedEvents(
  role: RoleId,
  reference: string,
  validation: ModelValidation,
  catalog: ModelCatalog,
  events: ModelResolutionEvent[],
): void {
  if (validation.skipped) {
    events.push({
      type: "model.validation_skipped",
      role,
      model: reference,
      reason: "The model catalog is unavailable; existence and capability checks were skipped.",
    });
  }
  if (!catalog.providersAvailable) {
    events.push({
      type: "model.validation_skipped",
      role,
      model: reference,
      reason: "The provider catalog is unavailable; provider availability could not be checked.",
    });
  }
  if (validation.candidate?.model && validation.candidate.model.tools === undefined) {
    events.push({
      type: "model.validation_skipped",
      role,
      model: reference,
      reason: "Tool-calling capability metadata is missing for the selected model.",
    });
  }
}

function addDiversityWarning(
  config: ModelsConfig,
  routes: Partial<Record<RoleId, RoleModelResolution>>,
  events: ModelResolutionEvent[],
): void {
  if (!config.diversity) return;
  const developer = routes.developer;
  const adversary = routes.adversary;
  if (!developer || !adversary) return;

  const same = developer.source === "inherit" && adversary.source === "inherit"
    ? true
    : sameBaseModel(developer.effectiveModel, adversary.effectiveModel);
  if (!same) return;

  events.push({
    type: "model.diversity_warning",
    role: "adversary",
    ...(adversary.effectiveModel ? { model: adversary.effectiveModel } : {}),
    reason: "The adversary and developer resolve to the same effective model; independent review may be weaker.",
  });
}

function sameBaseModel(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return stripVariant(left) === stripVariant(right);
}

function findCatalogModel(reference: string | null, catalog: ModelCatalog): CatalogModel | undefined {
  if (!reference) return undefined;
  try {
    const parsed = parseModelReference(reference);
    return catalog.models.find(
      (entry) => entry.providerID === String(parsed.providerID) && entry.modelID === String(parsed.id),
    );
  } catch {
    return undefined;
  }
}

function safeVariant(reference: string): string | undefined {
  try {
    const variant = parseModelReference(reference).variant;
    return variant ? String(variant) : undefined;
  } catch {
    return undefined;
  }
}

function stripVariant(reference: string): string {
  const separator = reference.indexOf("#");
  return separator < 0 ? reference : reference.slice(0, separator);
}

function unsupportedParam(
  events: ModelResolutionEvent[],
  role: RoleId,
  model: string | null,
  key: string,
  reason: string,
): void {
  events.push({
    type: "model.param_unsupported",
    role,
    ...(model ? { model } : {}),
    reason: `Model parameter '${key}' was ignored: ${reason}.`,
  });
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
