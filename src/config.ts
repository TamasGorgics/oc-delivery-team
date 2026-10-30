import path from "node:path";
import {
  MODEL_TIERS,
  ROLE_IDS,
  isModelTier,
  isRoleId,
  type ModelTier,
  type RoleId,
} from "./roles";

export interface ConfigWarning {
  readonly path: string;
  readonly message: string;
}

export interface RawModelSpec {
  readonly model: string;
  readonly params?: Record<string, unknown>;
  readonly fallback?: string[];
}

export interface ModelsConfig {
  readonly default?: RawModelSpec;
  readonly tiers: Partial<Record<ModelTier, RawModelSpec>>;
  readonly roles: Partial<Record<RoleId, RawModelSpec>>;
  readonly roleTier: Partial<Record<RoleId, ModelTier>>;
  readonly params: Partial<Record<RoleId, Record<string, unknown>>>;
  readonly diversity: boolean;
  readonly auto: boolean;
}

export interface LessonsConfig {
  readonly topN: number;
  readonly budgetChars: number;
}

export interface StackConfig {
  readonly detect: boolean;
  readonly overrides?: Record<string, unknown>;
}

export interface RolesConfig {
  readonly disabled: readonly RoleId[];
}

export interface GatingConfig {
  readonly enabled: boolean;
  readonly strict: boolean;
  readonly editTools: readonly string[];
}

export interface TraceConfig {
  readonly captureInput: boolean;
  readonly previewChars: number;
}

export interface WorktreesConfig {
  readonly enabled: boolean;
  readonly baseDir: string;
}

export interface DeliveryTeamConfig {
  readonly root: string;
  readonly rootDir: string;
  readonly projectDir: string;
  readonly dbPath: string;
  readonly maxLoops: number;
  readonly lessons: LessonsConfig;
  readonly models: ModelsConfig;
  readonly stack: StackConfig;
  readonly roles: RolesConfig;
  readonly gating: GatingConfig;
  readonly trace: TraceConfig;
  readonly worktrees: WorktreesConfig;
  readonly warnings: readonly ConfigWarning[];
}

const TOP_LEVEL_KEYS = new Set([
  "root",
  "dbPath",
  "maxLoops",
  "lessons",
  "models",
  "stack",
  "roles",
  "gating",
  "trace",
  "worktrees",
]);

const LESSONS_KEYS = new Set(["topN", "budgetChars"]);
const STACK_KEYS = new Set(["detect", "overrides"]);
const ROLES_KEYS = new Set(["disabled"]);
const GATING_KEYS = new Set(["enabled", "strict", "editTools"]);
const TRACE_KEYS = new Set(["captureInput", "previewChars"]);
const WORKTREES_KEYS = new Set(["enabled", "baseDir"]);
const MODEL_KEYS = new Set(["default", "tiers", "roles", "roleTier", "params", "diversity", "auto"]);
const MODEL_SPEC_KEYS = new Set(["model", "params", "fallback"]);

export function parseConfig(
  raw: unknown,
  projectDir: string,
  dataBaseDir: string = projectDir,
): DeliveryTeamConfig {
  const warnings: ConfigWarning[] = [];
  const options = isRecord(raw) ? raw : {};

  if (raw !== undefined && !isRecord(raw)) {
    warnings.push({ path: "options", message: "Plugin options must be an object; using defaults." });
  }

  for (const key of Object.keys(options)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      warnings.push({ path: key, message: "Unknown option; ignored." });
    }
  }

  const root = readString(options.root, ".team", "root", warnings);
  const rootDir = path.isAbsolute(root) ? path.normalize(root) : path.resolve(dataBaseDir, root);
  const configuredDbPath = readString(options.dbPath, path.join(root, "team.db"), "dbPath", warnings);
  const dbPath = path.isAbsolute(configuredDbPath)
    ? path.normalize(configuredDbPath)
    : path.resolve(dataBaseDir, configuredDbPath);

  const maxLoops = readPositiveInt(options.maxLoops, 3, "maxLoops", warnings);

  const lessonsRaw = readObject(options.lessons, "lessons", warnings);
  warnUnknown(lessonsRaw, LESSONS_KEYS, "lessons", warnings);
  const lessons: LessonsConfig = {
    topN: readPositiveInt(lessonsRaw.topN, 8, "lessons.topN", warnings),
    budgetChars: readPositiveInt(lessonsRaw.budgetChars, 4000, "lessons.budgetChars", warnings),
  };

  const stackRaw = readObject(options.stack, "stack", warnings);
  warnUnknown(stackRaw, STACK_KEYS, "stack", warnings);
  const stack: StackConfig = {
    detect: readBoolean(stackRaw.detect, true, "stack.detect", warnings),
    overrides: readOptionalObject(stackRaw.overrides, "stack.overrides", warnings),
  };

  const rolesRaw = readObject(options.roles, "roles", warnings);
  warnUnknown(rolesRaw, ROLES_KEYS, "roles", warnings);
  const disabled = readRoleList(rolesRaw.disabled, warnings);

  const gatingRaw = readObject(options.gating, "gating", warnings);
  warnUnknown(gatingRaw, GATING_KEYS, "gating", warnings);
  const gating: GatingConfig = {
    enabled: readBoolean(gatingRaw.enabled, true, "gating.enabled", warnings),
    strict: readBoolean(gatingRaw.strict, false, "gating.strict", warnings),
    editTools: readStringList(gatingRaw.editTools, ["edit", "write", "patch"], "gating.editTools", warnings),
  };

  const traceRaw = readObject(options.trace, "trace", warnings);
  warnUnknown(traceRaw, TRACE_KEYS, "trace", warnings);
  const trace: TraceConfig = {
    captureInput: readBoolean(traceRaw.captureInput, false, "trace.captureInput", warnings),
    previewChars: readNonNegativeInt(traceRaw.previewChars, 0, "trace.previewChars", warnings),
  };

  const worktreesRaw = readObject(options.worktrees, "worktrees", warnings);
  warnUnknown(worktreesRaw, WORKTREES_KEYS, "worktrees", warnings);
  const worktrees: WorktreesConfig = {
    enabled: readBoolean(worktreesRaw.enabled, false, "worktrees.enabled", warnings),
    baseDir: readString(worktreesRaw.baseDir, "../.team-worktrees", "worktrees.baseDir", warnings),
  };

  return {
    root,
    rootDir,
    projectDir,
    dbPath,
    maxLoops,
    lessons,
    models: parseModels(options.models, warnings),
    stack,
    roles: { disabled },
    gating,
    trace,
    worktrees,
    warnings,
  };
}

function parseModels(raw: unknown, warnings: ConfigWarning[]): ModelsConfig {
  const modelsRaw = readObject(raw, "models", warnings);
  warnUnknown(modelsRaw, MODEL_KEYS, "models", warnings);

  const tiersRaw = readObject(modelsRaw.tiers, "models.tiers", warnings);
  const tiers: Partial<Record<ModelTier, RawModelSpec>> = {};
  for (const key of Object.keys(tiersRaw)) {
    if (!isModelTier(key)) {
      warnings.push({ path: `models.tiers.${key}`, message: "Unknown model tier; ignored." });
      continue;
    }
    const spec = parseModelSpec(tiersRaw[key], `models.tiers.${key}`, warnings);
    if (spec) tiers[key] = spec;
  }

  const rolesRaw = readObject(modelsRaw.roles, "models.roles", warnings);
  const roles: Partial<Record<RoleId, RawModelSpec>> = {};
  for (const key of Object.keys(rolesRaw)) {
    if (!isRoleId(key)) {
      warnings.push({ path: `models.roles.${key}`, message: "Unknown role; ignored." });
      continue;
    }
    const spec = parseModelSpec(rolesRaw[key], `models.roles.${key}`, warnings);
    if (spec) roles[key] = spec;
  }

  const roleTierRaw = readObject(modelsRaw.roleTier, "models.roleTier", warnings);
  const roleTier: Partial<Record<RoleId, ModelTier>> = {};
  for (const key of Object.keys(roleTierRaw)) {
    if (!isRoleId(key)) {
      warnings.push({ path: `models.roleTier.${key}`, message: "Unknown role; ignored." });
      continue;
    }
    const tier = roleTierRaw[key];
    if (!isModelTier(tier)) {
      warnings.push({ path: `models.roleTier.${key}`, message: "Unknown model tier; ignored." });
      continue;
    }
    roleTier[key] = tier;
  }

  const paramsRaw = readObject(modelsRaw.params, "models.params", warnings);
  const params: Partial<Record<RoleId, Record<string, unknown>>> = {};
  for (const key of Object.keys(paramsRaw)) {
    if (!isRoleId(key)) {
      warnings.push({ path: `models.params.${key}`, message: "Unknown role; ignored." });
      continue;
    }
    const value = paramsRaw[key];
    if (!isRecord(value)) {
      warnings.push({ path: `models.params.${key}`, message: "Params must be an object; ignored." });
      continue;
    }
    params[key] = { ...value };
  }

  return {
    default: parseModelSpec(modelsRaw.default, "models.default", warnings),
    tiers,
    roles,
    roleTier,
    params,
    diversity: readBoolean(modelsRaw.diversity, true, "models.diversity", warnings),
    auto: readBoolean(modelsRaw.auto, false, "models.auto", warnings),
  };
}

function parseModelSpec(raw: unknown, at: string, warnings: ConfigWarning[]): RawModelSpec | undefined {
  if (raw === undefined) return undefined;

  if (typeof raw === "string") {
    const model = raw.trim();
    if (!model) {
      warnings.push({ path: at, message: "Model reference must not be empty; ignored." });
      return undefined;
    }
    return { model };
  }

  if (!isRecord(raw)) {
    warnings.push({ path: at, message: "Model spec must be a string or an object; ignored." });
    return undefined;
  }

  warnUnknown(raw, MODEL_SPEC_KEYS, at, warnings);

  if (typeof raw.model !== "string" || !raw.model.trim()) {
    warnings.push({ path: `${at}.model`, message: "Model reference is required; spec ignored." });
    return undefined;
  }

  let params: Record<string, unknown> | undefined;
  if (raw.params !== undefined) {
    if (isRecord(raw.params)) {
      params = { ...raw.params };
    } else {
      warnings.push({ path: `${at}.params`, message: "Params must be an object; ignored." });
    }
  }

  let fallback: string[] | undefined;
  if (raw.fallback !== undefined) {
    if (Array.isArray(raw.fallback)) {
      fallback = raw.fallback
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim());
      if (fallback.length !== raw.fallback.length) {
        warnings.push({ path: `${at}.fallback`, message: "Invalid fallback entries were ignored." });
      }
      if (fallback.length === 0) fallback = undefined;
    } else {
      warnings.push({ path: `${at}.fallback`, message: "Fallback must be a string array; ignored." });
    }
  }

  return {
    model: raw.model.trim(),
    ...(params ? { params } : {}),
    ...(fallback ? { fallback } : {}),
  };
}

function readRoleList(raw: unknown, warnings: ConfigWarning[]): RoleId[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push({ path: "roles.disabled", message: "Must be a string array; ignored." });
    return [];
  }
  const result: RoleId[] = [];
  for (const entry of raw) {
    if (isRoleId(entry)) {
      if (!result.includes(entry)) result.push(entry);
    } else {
      warnings.push({ path: "roles.disabled", message: `Unknown role ${JSON.stringify(entry)}; ignored.` });
    }
  }
  return result;
}

function readObject(raw: unknown, at: string, warnings: ConfigWarning[]): Record<string, unknown> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    warnings.push({ path: at, message: "Must be an object; using defaults." });
    return {};
  }
  return raw;
}

function readOptionalObject(
  raw: unknown,
  at: string,
  warnings: ConfigWarning[],
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    warnings.push({ path: at, message: "Must be an object; ignored." });
    return undefined;
  }
  return { ...raw };
}

function readString(raw: unknown, fallback: string, at: string, warnings: ConfigWarning[]): string {
  if (raw === undefined) return fallback;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  warnings.push({ path: at, message: "Must be a non-empty string; using default." });
  return fallback;
}

function readBoolean(raw: unknown, fallback: boolean, at: string, warnings: ConfigWarning[]): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw === "boolean") return raw;
  warnings.push({ path: at, message: "Must be a boolean; using default." });
  return fallback;
}

function readPositiveInt(raw: unknown, fallback: number, at: string, warnings: ConfigWarning[]): number {
  if (raw === undefined) return fallback;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  warnings.push({ path: at, message: "Must be a positive integer; using default." });
  return fallback;
}

function readNonNegativeInt(raw: unknown, fallback: number, at: string, warnings: ConfigWarning[]): number {
  if (raw === undefined) return fallback;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  warnings.push({ path: at, message: "Must be a non-negative integer; using default." });
  return fallback;
}

function readStringList(
  raw: unknown,
  fallback: readonly string[],
  at: string,
  warnings: ConfigWarning[],
): string[] {
  if (raw === undefined) return [...fallback];
  if (!Array.isArray(raw)) {
    warnings.push({ path: at, message: "Must be a string array; using default." });
    return [...fallback];
  }
  if (raw.length === 0) return [];

  const result = raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (result.length !== raw.length || result.length === 0) {
    warnings.push({ path: at, message: "Invalid entries were ignored; using default when empty." });
    return result.length > 0 ? result.map((entry) => entry.trim()) : [...fallback];
  }
  return result.map((entry) => entry.trim());
}

function warnUnknown(
  source: Record<string, unknown>,
  known: ReadonlySet<string>,
  at: string,
  warnings: ConfigWarning[],
): void {
  for (const key of Object.keys(source)) {
    if (!known.has(key)) {
      warnings.push({ path: at ? `${at}.${key}` : key, message: "Unknown option; ignored." });
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

// Keep the role ids referenced from this module's type space explicit for consumers.
export type { ModelTier, RoleId };
export { MODEL_TIERS, ROLE_IDS };
