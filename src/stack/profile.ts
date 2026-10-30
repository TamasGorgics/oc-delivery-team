import { isRecord } from "../config";

export type StackSource = "detected" | "researcher" | "human";

export const STACK_COMMAND_KEYS = [
  "install",
  "build",
  "test",
  "lint",
  "format",
  "typecheck",
  "run",
] as const;

export type StackCommandKey = (typeof STACK_COMMAND_KEYS)[number];

export type StackCommands = Readonly<Record<StackCommandKey, string | null>>;

export interface StackGlobs {
  readonly source: readonly string[];
  readonly tests: readonly string[];
  readonly docs: readonly string[];
  readonly ignore: readonly string[];
}

export interface StackComponent {
  readonly name: string;
  readonly root: string;
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly packageManager: string | null;
  readonly commands: StackCommands;
  readonly globs: StackGlobs;
}

export interface StackProfile {
  readonly version: 1;
  readonly source: StackSource;
  readonly components: readonly StackComponent[];
  readonly notes?: string;
  readonly shell?: string;
}

export interface StackDiagnostic {
  readonly path: string;
  readonly message: string;
  readonly severity: "error" | "warning";
}

export interface StackParseResult {
  readonly profile?: StackProfile;
  readonly diagnostics: readonly StackDiagnostic[];
}

export interface StackMergeResult extends StackParseResult {
  readonly merged?: StackProfile;
}

export const DEFAULT_TEST_GLOBS = [
  "**/*_test.*",
  "**/*.test.*",
  "**/*.spec.*",
  "**/test_*.*",
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/*Test.java",
  "**/*Tests.cs",
] as const;

export const DEFAULT_DOC_GLOBS = [
  "README*",
  "docs/**",
  "**/*.md",
] as const;

const COMMAND_KEY_SET = new Set<string>(STACK_COMMAND_KEYS);
const SOURCES = new Set<StackSource>(["detected", "researcher", "human"]);

export function emptyStackProfile(): StackProfile {
  return { version: 1, source: "detected", components: [] };
}

export function parseStackProfile(raw: unknown): StackParseResult {
  const diagnostics: StackDiagnostic[] = [];
  if (raw === undefined) return { profile: emptyStackProfile(), diagnostics };

  if (!isRecord(raw)) {
    diagnostics.push({ path: "", message: "Stack profile must be an object.", severity: "error" });
    return { diagnostics };
  }

  const version = raw.version === undefined ? 1 : raw.version;
  if (version !== 1) {
    diagnostics.push({ path: "version", message: "Only stack profile version 1 is supported.", severity: "error" });
  }

  const source = raw.source === undefined ? "detected" : raw.source;
  if (typeof source !== "string" || !SOURCES.has(source as StackSource)) {
    diagnostics.push({
      path: "source",
      message: "source must be detected, researcher, or human.",
      severity: "error",
    });
  }

  const componentsRaw = raw.components === undefined ? [] : raw.components;
  const components: StackComponent[] = [];
  if (!Array.isArray(componentsRaw)) {
    diagnostics.push({ path: "components", message: "components must be an array.", severity: "error" });
  } else {
    componentsRaw.forEach((entry, index) => {
      const component = parseComponent(entry, `components[${index}]`, diagnostics);
      if (component) components.push(component);
    });
  }

  for (const key of Object.keys(raw)) {
    if (!["version", "source", "components", "notes", "shell"].includes(key)) {
      diagnostics.push({ path: key, message: "Unknown stack profile field; ignored.", severity: "warning" });
    }
  }

  let notes: string | undefined;
  if (raw.notes !== undefined) {
    if (typeof raw.notes === "string") notes = raw.notes;
    else diagnostics.push({ path: "notes", message: "notes must be a string.", severity: "error" });
  }

  let shell: string | undefined;
  if (raw.shell !== undefined) {
    if (typeof raw.shell === "string") shell = raw.shell;
    else diagnostics.push({ path: "shell", message: "shell must be a string.", severity: "error" });
  }

  if (hasErrors(diagnostics)) return { diagnostics };

  const profile: StackProfile = {
    version: 1,
    source: source as StackSource,
    components,
    ...(notes !== undefined ? { notes } : {}),
    ...(shell !== undefined ? { shell } : {}),
  };
  return { profile, diagnostics };
}

function parseComponent(
  raw: unknown,
  at: string,
  diagnostics: StackDiagnostic[],
): StackComponent | undefined {
  if (!isRecord(raw)) {
    diagnostics.push({ path: at, message: "Component must be an object.", severity: "error" });
    return undefined;
  }

  const name = readRequiredString(raw.name, `${at}.name`, diagnostics);
  const root = readOptionalString(raw.root, ".", `${at}.root`, diagnostics);
  const languages = readStringArray(raw.languages, `${at}.languages`, diagnostics);
  const frameworks = readStringArray(raw.frameworks, `${at}.frameworks`, diagnostics);
  const packageManager = readNullableString(raw.packageManager, `${at}.packageManager`, diagnostics);
  const commands = parseCommands(raw.commands, `${at}.commands`, diagnostics);
  const globs = parseGlobs(raw.globs, `${at}.globs`, diagnostics);

  for (const key of Object.keys(raw)) {
    if (!["name", "root", "languages", "frameworks", "packageManager", "commands", "globs"].includes(key)) {
      diagnostics.push({ path: `${at}.${key}`, message: "Unknown component field; ignored.", severity: "warning" });
    }
  }

  if (!name) return undefined;
  return {
    name,
    root,
    languages,
    frameworks,
    packageManager,
    commands,
    globs,
  };
}

function parseCommands(raw: unknown, at: string, diagnostics: StackDiagnostic[]): StackCommands {
  const result: Record<StackCommandKey, string | null> = {
    install: null,
    build: null,
    test: null,
    lint: null,
    format: null,
    typecheck: null,
    run: null,
  };
  if (raw === undefined) return result;
  if (!isRecord(raw)) {
    diagnostics.push({ path: at, message: "commands must be an object.", severity: "error" });
    return result;
  }

  for (const key of Object.keys(raw)) {
    if (!COMMAND_KEY_SET.has(key)) {
      diagnostics.push({ path: `${at}.${key}`, message: "Unknown command key; ignored.", severity: "warning" });
      continue;
    }
    const value = raw[key];
    if (value === null) {
      result[key as StackCommandKey] = null;
    } else if (typeof value === "string" && value.trim().length > 0) {
      result[key as StackCommandKey] = value;
    } else {
      diagnostics.push({ path: `${at}.${key}`, message: "Command must be a string or null.", severity: "error" });
    }
  }
  return result;
}

function parseGlobs(raw: unknown, at: string, diagnostics: StackDiagnostic[]): StackGlobs {
  const result = { source: [] as string[], tests: [] as string[], docs: [] as string[], ignore: [] as string[] };
  if (raw === undefined) return result;
  if (!isRecord(raw)) {
    diagnostics.push({ path: at, message: "globs must be an object.", severity: "error" });
    return result;
  }

  for (const key of Object.keys(raw)) {
    if (!["source", "tests", "docs", "ignore"].includes(key)) {
      diagnostics.push({ path: `${at}.${key}`, message: "Unknown globs field; ignored.", severity: "warning" });
      continue;
    }
    result[key as keyof StackGlobs] = readStringArray(raw[key], `${at}.${key}`, diagnostics);
  }
  return result;
}

function readRequiredString(raw: unknown, at: string, diagnostics: StackDiagnostic[]): string | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  diagnostics.push({ path: at, message: "Must be a non-empty string.", severity: "error" });
  return undefined;
}

function readOptionalString(
  raw: unknown,
  fallback: string,
  at: string,
  diagnostics: StackDiagnostic[],
): string {
  if (raw === undefined) return fallback;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  diagnostics.push({ path: at, message: "Must be a non-empty string.", severity: "error" });
  return fallback;
}

function readNullableString(raw: unknown, at: string, diagnostics: StackDiagnostic[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return raw;
  diagnostics.push({ path: at, message: "Must be a string or null.", severity: "error" });
  return null;
}

function readStringArray(raw: unknown, at: string, diagnostics: StackDiagnostic[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    diagnostics.push({ path: at, message: "Must be an array of strings.", severity: "error" });
    return [];
  }
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") result.push(entry);
    else diagnostics.push({ path: at, message: "Array entries must be strings.", severity: "error" });
  }
  return result;
}

export function hasStackErrors(diagnostics: readonly StackDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function hasErrors(diagnostics: readonly StackDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function mergeStackProfile(base: unknown, patch: unknown): StackMergeResult {
  if (!isRecord(patch)) {
    return {
      diagnostics: [{ path: "", message: "Stack patch must be an object.", severity: "error" }],
    };
  }
  const mergedRaw = mergeJson(base, patch);
  const parsed = parseStackProfile(mergedRaw);
  return { ...parsed, ...(parsed.profile ? { merged: parsed.profile } : {}) };
}

export function applyStackPatch(base: StackProfile, patch: unknown): StackMergeResult {
  return mergeStackProfile(base, patch);
}

function mergeJson(base: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return patch;
  const result: Record<string, unknown> = isRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else {
      result[key] = mergeJson(result[key], value);
    }
  }
  return result;
}

export function cloneStackProfile(profile: StackProfile): StackProfile {
  return JSON.parse(JSON.stringify(profile)) as StackProfile;
}

export function resolveScopeGlobs(profile: StackProfile): {
  readonly tests: readonly string[];
  readonly docs: readonly string[];
  readonly defaulted: boolean;
} {
  const tests: string[] = [];
  const docs: string[] = [];
  let defaulted = false;

  for (const component of profile.components) {
    if (component.globs.tests.length === 0) {
      tests.push(...DEFAULT_TEST_GLOBS);
      defaulted = true;
    } else {
      tests.push(...component.globs.tests);
    }
    if (component.globs.docs.length === 0) {
      docs.push(...DEFAULT_DOC_GLOBS);
      defaulted = true;
    } else {
      docs.push(...component.globs.docs);
    }
  }

  if (profile.components.length === 0) {
    tests.push(...DEFAULT_TEST_GLOBS);
    docs.push(...DEFAULT_DOC_GLOBS);
    defaulted = true;
  }

  return { tests: unique(tests), docs: unique(docs), defaulted };
}

export function profileHasTestCommand(profile: StackProfile): boolean {
  return profile.components.some((component) => {
    const command = component.commands.test;
    return typeof command === "string" && command.trim().length > 0;
  });
}

export function findHumanOwnedConflicts(human: unknown, patch: unknown, prefix = ""): string[] {
  if (!isRecord(patch)) return [];
  if (!isRecord(human)) return Object.keys(patch).map((key) => joinPath(prefix, key));

  const conflicts: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = joinPath(prefix, key);
    if (!(key in human)) continue;
    const base = human[key];
    if (isRecord(base) && isRecord(value)) {
      conflicts.push(...findHumanOwnedConflicts(base, value, path));
    } else {
      conflicts.push(path);
    }
  }
  return conflicts;
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
