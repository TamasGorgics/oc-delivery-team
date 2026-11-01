import { lstatSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isRecord, parseConfig } from "../config";
import { STACK_COMMAND_KEYS, type StackCommandKey } from "../stack/profile";
import type { EvalCriterion, EvalModelPreset, EvalTask } from "./types";

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_TASK_TEXT_BYTES = 100_000;
const MAX_CRITERIA_BYTES = 100_000;
const MAX_CRITERIA_COUNT = 100;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const REGEX_FLAGS = new Set(["i", "m", "s", "u"]);

export const EVALS_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const EVAL_TASKS_DIRECTORY = path.join(EVALS_PACKAGE_ROOT, "evals", "tasks");
export const EVAL_MODELS_DIRECTORY = path.join(EVALS_PACKAGE_ROOT, "evals", "models");

export function isSafeEvalName(value: string): boolean {
  return SAFE_NAME.test(value);
}

export function listEvalTaskNames(directory = EVAL_TASKS_DIRECTORY): string[] {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return [...entries]
    .filter((entry) => entry.isDirectory() && isSafeEvalName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function loadEvalTasks(
  names: readonly string[] = [],
  directory = EVAL_TASKS_DIRECTORY,
): EvalTask[] {
  const selected = names.length === 0 ? listEvalTaskNames(directory) : [...new Set(names)];
  if (selected.length === 0) throw new Error(`No evaluation tasks were found in ${directory}.`);
  return selected.map((name) => loadEvalTask(name, directory));
}

export function loadEvalTask(name: string, directory = EVAL_TASKS_DIRECTORY): EvalTask {
  if (!isSafeEvalName(name)) throw new Error(`Invalid evaluation task name: ${JSON.stringify(name)}.`);
  const taskDirectory = path.join(directory, name);
  const taskStat = lstatSync(taskDirectory);
  if (!taskStat.isDirectory() || taskStat.isSymbolicLink()) {
    throw new Error(`Evaluation task is not a regular directory: ${name}.`);
  }

  const taskText = readLimitedFile(path.join(taskDirectory, "task.md"), MAX_TASK_TEXT_BYTES).trim();
  if (!taskText) throw new Error(`Evaluation task ${name} has an empty task.md.`);
  const criteriaText = readLimitedFile(path.join(taskDirectory, "criteria.json"), MAX_CRITERIA_BYTES);
  const criteria = parseCriteria(criteriaText, name);
  const fixtureDirectory = path.join(taskDirectory, "fixture");
  const fixtureStat = lstatSync(fixtureDirectory);
  if (!fixtureStat.isDirectory() || fixtureStat.isSymbolicLink()) {
    throw new Error(`Evaluation task ${name} must have a regular fixture/ directory.`);
  }
  return { name, directory: taskDirectory, fixtureDirectory, taskText, criteria };
}

export function loadEvalModelPreset(
  name: string,
  directory = EVAL_MODELS_DIRECTORY,
): EvalModelPreset {
  if (!isSafeEvalName(name)) throw new Error(`Invalid model preset name: ${JSON.stringify(name)}.`);
  const presetPath = path.join(directory, `${name}.json`);
  const rawText = readLimitedFile(presetPath, MAX_CRITERIA_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Invalid model preset ${name}: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) throw new Error(`Model preset ${name} must be a JSON object.`);
  const unknown = Object.keys(value).filter((key) => key !== "hostModel" && key !== "models" && key !== "description");
  if (unknown.length > 0) throw new Error(`Model preset ${name} has unknown key(s): ${unknown.join(", ")}.`);

  const hostModel = value.hostModel;
  const normalizedHostModel = typeof hostModel === "string" ? hostModel.trim() : undefined;
  if (hostModel !== undefined && hostModel !== null && !normalizedHostModel) {
    throw new Error(`Model preset ${name}.hostModel must be a non-empty string when provided.`);
  }
  if (normalizedHostModel
    && (normalizedHostModel.length > 200 || normalizedHostModel.startsWith("-") || /[\0\r\n]/.test(normalizedHostModel))) {
    throw new Error(`Model preset ${name}.hostModel is not a safe OpenCode model reference.`);
  }
  const models = value.models;
  if (models !== undefined && !isRecord(models)) {
    throw new Error(`Model preset ${name}.models must be an object when provided.`);
  }
  const modelWarnings = parseConfig({ models: models ?? {} }, process.cwd()).warnings
    .filter((warning) => warning.path === "models" || warning.path.startsWith("models."));
  if (modelWarnings.length > 0) {
    throw new Error(`Model preset ${name} has invalid model configuration: ${modelWarnings.map((warning) => warning.message).join(" ")}`);
  }
  return {
    name,
    ...(normalizedHostModel ? { hostModel: normalizedHostModel } : {}),
    ...(models ? { models } : {}),
    raw: value,
  };
}

function parseCriteria(raw: string, taskName: string): EvalCriterion[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid criteria.json for ${taskName}: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.criteria)) {
    throw new Error(`criteria.json for ${taskName} must contain version: 1 and a criteria array.`);
  }
  if (value.criteria.length === 0 || value.criteria.length > MAX_CRITERIA_COUNT) {
    throw new Error(`criteria.json for ${taskName} must have 1-${MAX_CRITERIA_COUNT} criteria.`);
  }
  const ids = new Set<string>();
  return value.criteria.map((entry, index) => parseCriterion(entry, taskName, index, ids));
}

function parseCriterion(
  raw: unknown,
  taskName: string,
  index: number,
  ids: Set<string>,
): EvalCriterion {
  if (!isRecord(raw)) throw new Error(`Criterion ${index + 1} in ${taskName} must be an object.`);
  const id = raw.id;
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(id) || ids.has(id)) {
    throw new Error(`Criterion ${index + 1} in ${taskName} must have a unique safe id.`);
  }
  ids.add(id);
  const weight = raw.weight === undefined ? 1 : raw.weight;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || weight > 100) {
    throw new Error(`Criterion ${id} in ${taskName} must have a weight in (0, 100].`);
  }
  const description = typeof raw.description === "string" ? raw.description.slice(0, 500) : undefined;

  if (raw.type === "file_exists") {
    const file = requireRelativePath(raw.path, taskName, id);
    return { id, type: "file_exists", path: file, weight, ...(description ? { description } : {}) };
  }
  if (raw.type === "regex") {
    const file = requireRelativePath(raw.path, taskName, id);
    const pattern = raw.pattern;
    const flags = raw.flags === undefined ? "" : raw.flags;
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 2_000) {
      throw new Error(`Regex criterion ${id} in ${taskName} needs a pattern of 1-2,000 characters.`);
    }
    if (typeof flags !== "string" || [...flags].some((flag) => !REGEX_FLAGS.has(flag))
      || new Set(flags).size !== flags.length) {
      throw new Error(`Regex criterion ${id} in ${taskName} has unsupported or duplicate flags.`);
    }
    try {
      new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`Regex criterion ${id} in ${taskName} is invalid: ${errorMessage(error)}`);
    }
    return {
      id,
      type: "regex",
      path: file,
      pattern,
      flags,
      weight,
      ...(description ? { description } : {}),
    };
  }
  if (raw.type === "stack_command") {
    if (typeof raw.key !== "string" || !(STACK_COMMAND_KEYS as readonly string[]).includes(raw.key)) {
      throw new Error(`Stack command criterion ${id} in ${taskName} has an invalid command key.`);
    }
    const expectedExitCode = raw.expectedExitCode === undefined ? 0 : raw.expectedExitCode;
    const timeoutMs = raw.timeoutMs === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : raw.timeoutMs;
    if (!Number.isInteger(expectedExitCode) || typeof expectedExitCode !== "number") {
      throw new Error(`Stack command criterion ${id} in ${taskName} needs an integer expectedExitCode.`);
    }
    if (!Number.isInteger(timeoutMs) || typeof timeoutMs !== "number"
      || timeoutMs < 1 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
      throw new Error(`Stack command criterion ${id} in ${taskName} needs a timeoutMs in 1-${MAX_COMMAND_TIMEOUT_MS}.`);
    }
    return {
      id,
      type: "stack_command",
      key: raw.key as StackCommandKey,
      expectedExitCode,
      timeoutMs,
      weight,
      ...(description ? { description } : {}),
    };
  }
  throw new Error(`Criterion ${id} in ${taskName} has unsupported type ${JSON.stringify(raw.type)}.`);
}

function requireRelativePath(value: unknown, taskName: string, criterionId: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || path.isAbsolute(value)) {
    throw new Error(`Criterion ${criterionId} in ${taskName} needs a safe relative path.`);
  }
  const normalized = path.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Criterion ${criterionId} in ${taskName} path escapes the fixture.`);
  }
  return normalized;
}

function readLimitedFile(filePath: string, maxBytes: number): string {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${filePath}`);
  if (stat.size > maxBytes) throw new Error(`File is too large: ${filePath}`);
  return readFileSync(filePath, "utf8");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
