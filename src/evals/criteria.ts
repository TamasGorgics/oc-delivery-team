import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { StackProfile } from "../stack/profile";
import type { CriterionResult, EvalCriterion } from "./types";

const MAX_REGEX_FILE_BYTES = 1_000_000;
const MAX_CAPTURED_ERROR_CHARS = 500;

export function evaluateCriteria(
  criteria: readonly EvalCriterion[],
  fixtureDirectory: string,
  profile?: StackProfile,
): CriterionResult[] {
  return criteria.map((criterion) => {
    if (criterion.type === "file_exists") return checkFileExists(criterion, fixtureDirectory);
    if (criterion.type === "regex") return checkRegex(criterion, fixtureDirectory);
    return checkStackCommand(criterion, fixtureDirectory, profile);
  });
}

function checkFileExists(
  criterion: Extract<EvalCriterion, { readonly type: "file_exists" }>,
  fixtureDirectory: string,
): CriterionResult {
  const resolved = safeFixturePath(fixtureDirectory, criterion.path);
  if (!resolved.ok) return failed(criterion, resolved.message);
  try {
    const stat = lstatSync(resolved.path);
    const passed = stat.isFile() && !stat.isSymbolicLink();
    return passed
      ? { id: criterion.id, type: criterion.type, passed: true, weight: criterion.weight, message: "File exists." }
      : failed(criterion, "Path exists but is not a regular file.");
  } catch (error) {
    return failed(criterion, `File is missing: ${shortError(error)}`);
  }
}

function checkRegex(
  criterion: Extract<EvalCriterion, { readonly type: "regex" }>,
  fixtureDirectory: string,
): CriterionResult {
  const resolved = safeFixturePath(fixtureDirectory, criterion.path);
  if (!resolved.ok) return failed(criterion, resolved.message);
  try {
    const stat = lstatSync(resolved.path);
    if (!stat.isFile() || stat.isSymbolicLink()) return failed(criterion, "Regex target is not a regular file.");
    if (stat.size > MAX_REGEX_FILE_BYTES) return failed(criterion, "Regex target exceeds the 1 MB read limit.");
    const contents = readFileSync(resolved.path, "utf8");
    const passed = new RegExp(criterion.pattern, criterion.flags).test(contents);
    return passed
      ? { id: criterion.id, type: criterion.type, passed: true, weight: criterion.weight, message: "Pattern matched." }
      : failed(criterion, "Pattern did not match.");
  } catch (error) {
    return failed(criterion, `Could not evaluate regex target: ${shortError(error)}`);
  }
}

function checkStackCommand(
  criterion: Extract<EvalCriterion, { readonly type: "stack_command" }>,
  fixtureDirectory: string,
  profile: StackProfile | undefined,
): CriterionResult {
  if (!profile || profile.components.length === 0) {
    return failed(criterion, "No Stack Profile was available for this fixture.");
  }
  const components = profile.components;
  const missing = components.filter((component) => !component.commands[criterion.key]);
  if (missing.length > 0) {
    return failed(criterion, `Stack Profile has no '${criterion.key}' command for: ${missing.map((item) => item.name).join(", ")}.`);
  }

  const results = components.map((component) => {
    const command = component.commands[criterion.key];
    if (!command) return { component: component.name, passed: false, message: "Command is missing." };
    const argv = tokenizeStackCommand(command);
    if (!argv.ok) return { component: component.name, passed: false, message: argv.message };
    const cwd = safeFixturePath(fixtureDirectory, component.root);
    if (!cwd.ok) return { component: component.name, passed: false, message: cwd.message };

    const started = Date.now();
    const result = spawnSync(argv.value[0] as string, argv.value.slice(1), {
      cwd: cwd.path,
      encoding: "utf8",
      timeout: criterion.timeoutMs,
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const durationMs = Date.now() - started;
    const exitCode = result.status;
    const error = result.error ? shortError(result.error) : undefined;
    return {
      component: component.name,
      command_key: criterion.key,
      exit_code: exitCode,
      duration_ms: durationMs,
      passed: !result.error && exitCode === criterion.expectedExitCode,
      ...(error ? { error } : {}),
      ...(result.signal ? { signal: result.signal } : {}),
    };
  });
  const passed = results.every((result) => result.passed);
  return {
    id: criterion.id,
    type: criterion.type,
    passed,
    weight: criterion.weight,
    message: passed ? "Stack Profile command passed." : "One or more Stack Profile commands failed.",
    details: { commands: results },
  };
}

export function tokenizeStackCommand(command: string):
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly message: string } {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let tokenStarted = false;
  for (const character of command) {
    if (escaping) {
      token += character;
      tokenStarted = true;
      escaping = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/[;&|<>\n\r]/.test(character)) {
      return { ok: false, message: "Stack command uses shell control syntax; only a single argv command is allowed." };
    }
    if (/\s/.test(character)) {
      if (tokenStarted) tokens.push(token);
      token = "";
      tokenStarted = false;
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (escaping || quote) return { ok: false, message: "Stack command has an unterminated escape or quote." };
  if (tokenStarted) tokens.push(token);
  if (tokens.length === 0) return { ok: false, message: "Stack command is empty." };
  return { ok: true, value: tokens };
}

function safeFixturePath(
  fixtureDirectory: string,
  relative: string,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string } {
  const root = path.resolve(fixtureDirectory);
  const candidate = path.resolve(root, relative);
  if (path.isAbsolute(relative) || relative.includes("\0") || !isWithin(root, candidate)) {
    return { ok: false, message: "Path escapes the copied fixture." };
  }
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    if (!isWithin(realRoot, realCandidate)) return { ok: false, message: "Path resolves outside the copied fixture." };
    return { ok: true, path: realCandidate };
  } catch (error) {
    return { ok: false, message: `Path could not be resolved: ${shortError(error)}` };
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function failed(criterion: EvalCriterion, message: string): CriterionResult {
  return { id: criterion.id, type: criterion.type, passed: false, weight: criterion.weight, message };
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_CAPTURED_ERROR_CHARS);
}
