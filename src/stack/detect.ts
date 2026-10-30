import { isRecord } from "../config";
import {
  DEFAULT_COMMANDS,
  MARKER_RULES,
  PACKAGE_MANAGERS,
  WORKSPACE_MARKERS,
  type MarkerRule,
  type PackageManagerMarker,
} from "./markers";
import {
  emptyStackProfile,
  type StackCommandKey,
  type StackCommands,
  type StackComponent,
  type StackGlobs,
  type StackProfile,
} from "./profile";

export interface DetectionInput {
  /** Paths relative to the project root, using forward slashes. */
  readonly files: readonly string[];
  /** Read a small text file relative to the project root. */
  readonly readFile: (relativePath: string) => string | undefined;
}

export interface DetectionOptions {
  readonly maxComponents?: number;
}

type MutableCommands = { -readonly [K in StackCommandKey]: string | null };

const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  ".team",
  "node_modules",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "coverage",
  "vendor",
  ".gradle",
  ".idea",
  ".vscode",
]);

const FAMILY: Readonly<Record<string, string>> = {
  javascript: "js",
  typescript: "js",
};

const TASK_RUNNER_IDS = new Set(["make", "just", "task"]);

const TASK_KEYS: Readonly<Record<StackCommandKey, readonly string[]>> = {
  install: ["install", "deps", "dependencies", "setup"],
  build: ["build", "compile"],
  test: ["test", "tests", "check"],
  lint: ["lint", "check"],
  format: ["format", "fmt"],
  typecheck: ["typecheck", "type-check", "types"],
  run: ["run", "start", "dev", "serve"],
};

/**
 * Pure, side-effect-free stack detection. The caller supplies the file listing
 * and small file reads; this function never executes a command or touches the
 * network.
 */
export function detectStack(input: DetectionInput, options: DetectionOptions = {}): StackProfile {
  const files = normalizeFiles(input.files);
  const fileSet = new Set(files);
  const maxComponents = options.maxComponents ?? 100;
  const roots = discoverRoots(files, fileSet).slice(0, maxComponents);
  const usedNames = new Set<string>();
  const components: StackComponent[] = [];

  for (const root of roots) {
    const matching = MARKER_RULES.filter((rule) => (
      rule.kind === "component" &&
      !TASK_RUNNER_IDS.has(rule.id) &&
      matchesRuleAtRoot(files, root, rule)
    ));
    if (matching.length === 0) continue;

    const families = new Map<string, MarkerRule[]>();
    for (const rule of matching) {
      const family = FAMILY[rule.id] ?? rule.id;
      const list = families.get(family) ?? [];
      list.push(rule);
      families.set(family, list);
    }

    for (const [family, rules] of families) {
      const built = buildComponent(root, family, rules, files, fileSet, input);
      components.push({ ...built, name: uniqueName(built.name, usedNames) });
    }
  }

  if (components.length === 0) {
    const taskComponent = buildTaskOnlyComponent(files, fileSet, input);
    if (taskComponent) {
      components.push({ ...taskComponent, name: uniqueName(taskComponent.name, usedNames) });
    }
  }

  const notes = collectNotes(files, fileSet);
  const profile: StackProfile = {
    ...emptyStackProfile(),
    components,
    ...(notes.length > 0 ? { notes: notes.join(" ") } : {}),
  };
  return profile;
}

function buildComponent(
  root: string,
  family: string,
  rules: readonly MarkerRule[],
  files: readonly string[],
  fileSet: Set<string>,
  input: DetectionInput,
): StackComponent {
  const languages = unique(rules.flatMap((rule) => [...rule.languages]));
  const frameworks = unique(rules.flatMap((rule) => [...(rule.frameworks ?? [])]));
  const defaults: MutableCommands = { ...DEFAULT_COMMANDS };
  const globs: { source: string[]; tests: string[]; docs: string[]; ignore: string[] } = {
    source: [],
    tests: [],
    docs: [],
    ignore: [],
  };

  for (const rule of rules) {
    for (const key of Object.keys(defaults) as StackCommandKey[]) {
      const command = rule.commands?.[key];
      if (defaults[key] === null && command) defaults[key] = command;
    }
    for (const key of Object.keys(globs) as Array<keyof typeof globs>) {
      globs[key].push(...(rule.globs?.[key] ?? []));
    }
  }

  const packageManager = detectPackageManager(root, rules, fileSet, input);
  const repoCommands: Partial<MutableCommands> = {};
  applyCiCommands(repoCommands, files, input);
  applyTaskRunnerCommands(repoCommands, root, fileSet, input);
  if (family === "js") applyPackageScripts(repoCommands, root, packageManager, input);

  const commands: MutableCommands = { ...defaults };
  for (const key of Object.keys(repoCommands) as StackCommandKey[]) {
    const command = repoCommands[key];
    if (command) commands[key] = command;
  }

  return {
    name: root === "." ? "root" : basename(root),
    root,
    languages,
    frameworks,
    packageManager,
    commands,
    globs: {
      source: unique(globs.source),
      tests: unique(globs.tests),
      docs: unique(globs.docs),
      ignore: unique(globs.ignore),
    },
  };
}

function buildTaskOnlyComponent(
  files: readonly string[],
  fileSet: Set<string>,
  input: DetectionInput,
): StackComponent | undefined {
  const commands: Partial<MutableCommands> = {};
  applyTaskRunnerCommands(commands, ".", fileSet, input);
  if (Object.values(commands).every((command) => !command)) return undefined;

  return {
    name: "root",
    root: ".",
    languages: [],
    frameworks: unique(
      [
        hasFile(fileSet, "Makefile") || hasFile(fileSet, "makefile") ? "make" : undefined,
        hasFile(fileSet, "justfile") || hasFile(fileSet, "Justfile") ? "just" : undefined,
        hasFile(fileSet, "Taskfile.yml") || hasFile(fileSet, "Taskfile.yaml") ? "task" : undefined,
      ].filter((value): value is string => Boolean(value)),
    ),
    packageManager: null,
    commands: { ...DEFAULT_COMMANDS, ...commands },
    globs: { source: [], tests: [], docs: [], ignore: ["node_modules/**", "vendor/**"] },
  };
}

function discoverRoots(files: readonly string[], fileSet: Set<string>): string[] {
  const roots = new Set<string>(["."]);
  for (const file of files) {
    if (isIgnoredPath(file)) continue;
    const base = basename(file);
    for (const rule of MARKER_RULES) {
      if (rule.kind !== "component") continue;
      if (rule.manifests.some((pattern) => !pattern.includes("/") && matchGlob(base, pattern))) {
        roots.add(dirname(file));
      }
    }
  }
  void fileSet;
  return [...roots].sort((a, b) => a.localeCompare(b));
}

function matchesRuleAtRoot(files: readonly string[], root: string, rule: MarkerRule): boolean {
  return files.some((file) => {
    if (dirname(file) !== root || isIgnoredPath(file)) return false;
    const base = basename(file);
    return rule.manifests.some((pattern) => !pattern.includes("/") && matchGlob(base, pattern));
  });
}

function detectPackageManager(
  root: string,
  rules: readonly MarkerRule[],
  fileSet: Set<string>,
  input: DetectionInput,
): string | null {
  for (const rule of rules) {
    for (const marker of rule.packageManagers ?? []) {
      if (hasFileAt(fileSet, root, marker.marker)) return marker.name;
    }
  }

  if (hasFileAt(fileSet, root, "package.json")) {
    const packageJson = readJson(input, join(root, "package.json"));
    const declared = packageJson?.packageManager;
    if (typeof declared === "string") {
      const name = declared.split("@")[0]?.trim();
      if (name) return name;
    }
    return "npm";
  }
  return null;
}

function applyPackageScripts(
  target: Partial<MutableCommands>,
  root: string,
  packageManager: string | null,
  input: DetectionInput,
): void {
  const pm = packageManager ?? "npm";
  target.install = `${pm} install`;

  const packageJson = readJson(input, join(root, "package.json"));
  const scripts = isRecord(packageJson?.scripts) ? packageJson.scripts : {};
  const names = Object.keys(scripts).filter((name) => typeof scripts[name] === "string");

  for (const key of Object.keys(TASK_KEYS) as StackCommandKey[]) {
    if (key === "install") continue;
    const candidates = TASK_KEYS[key];
    const match = candidates.find((candidate) => names.includes(candidate))
      ?? (key === "run" ? names.find((name) => ["dev", "start", "serve"].includes(name)) : undefined);
    if (match) target[key] = runScript(pm, match);
  }
}

function applyTaskRunnerCommands(
  target: Partial<MutableCommands>,
  root: string,
  fileSet: Set<string>,
  input: DetectionInput,
): void {
  const makeFile = ["Makefile", "makefile", "GNUmakefile"].find((name) => hasFileAt(fileSet, root, name));
  if (makeFile) {
    const targets = parseMakeTargets(input.readFile(join(root, makeFile)));
    applyTargets(target, targets, (name) => `make ${name}`);
  }

  const justFile = ["justfile", "Justfile"].find((name) => hasFileAt(fileSet, root, name));
  if (justFile) {
    const targets = parseJustTargets(input.readFile(join(root, justFile)));
    applyTargets(target, targets, (name) => `just ${name}`);
  }

  const taskFile = ["Taskfile.yml", "Taskfile.yaml"].find((name) => hasFileAt(fileSet, root, name));
  if (taskFile) {
    const targets = parseTaskTargets(input.readFile(join(root, taskFile)));
    applyTargets(target, targets, (name) => `task ${name}`);
  }
}

function applyCiCommands(
  target: Partial<MutableCommands>,
  files: readonly string[],
  input: DetectionInput,
): void {
  const ciFiles = files.filter((file) => (
    matchPathGlob(file, ".github/workflows/*.yml") ||
    matchPathGlob(file, ".github/workflows/*.yaml") ||
    matchPathGlob(file, ".gitlab-ci.yml") ||
    matchPathGlob(file, ".circleci/config.yml")
  ));

  for (const file of ciFiles) {
    const contents = input.readFile(file);
    if (!contents) continue;
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*-?\s*run:\s*(.+?)\s*$/.exec(line);
      if (!match) continue;
      const command = match[1]?.replace(/^['"]|['"]$/g, "").trim();
      if (!command) continue;
      const key = commandKeyFor(command);
      if (key && !target[key]) target[key] = command;
    }
  }
}

function applyTargets(
  target: Partial<MutableCommands>,
  targets: ReadonlySet<string>,
  make: (name: string) => string,
): void {
  for (const key of Object.keys(TASK_KEYS) as StackCommandKey[]) {
    const match = TASK_KEYS[key].find((candidate) => targets.has(candidate));
    if (match) target[key] = make(match);
  }
}

function commandKeyFor(command: string): StackCommandKey | undefined {
  const lower = command.toLowerCase();
  if (/\btest(s)?\b/.test(lower)) return "test";
  if (/\bbuild\b/.test(lower)) return "build";
  if (/\blint\b/.test(lower)) return "lint";
  if (/\btypecheck\b|\btype-check\b/.test(lower)) return "typecheck";
  if (/\bformat\b|\bfmt\b/.test(lower)) return "format";
  if (/\binstall\b/.test(lower)) return "install";
  if (/\b(dev|start|serve)\b/.test(lower)) return "run";
  return undefined;
}

function parseMakeTargets(contents: string | undefined): Set<string> {
  const targets = new Set<string>();
  if (!contents) return targets;
  for (const line of contents.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line);
    if (match?.[1] && !match[1].startsWith(".")) targets.add(match[1]);
  }
  return targets;
}

function parseJustTargets(contents: string | undefined): Set<string> {
  const targets = new Set<string>();
  if (!contents) return targets;
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)(?:\s+[^:]*)?:/.exec(line);
    if (match?.[1] && !["set", "export", "alias", "import"].includes(match[1])) targets.add(match[1]);
  }
  return targets;
}

function parseTaskTargets(contents: string | undefined): Set<string> {
  const targets = new Set<string>();
  if (!contents) return targets;
  let inTasks = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^tasks:\s*$/.test(line)) {
      inTasks = true;
      continue;
    }
    if (inTasks && /^\S/.test(line) && line.trim().length > 0) break;
    if (!inTasks) continue;
    const match = /^\s{2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match?.[1]) targets.add(match[1]);
  }
  return targets;
}

function collectNotes(files: readonly string[], fileSet: Set<string>): string[] {
  const notes: string[] = [];
  for (const rule of MARKER_RULES) {
    if (rule.kind !== "tooling") continue;
    const matched = files.some((file) => rule.manifests.some((pattern) => (
      pattern.includes("/") ? matchPathGlob(file, pattern) : matchGlob(basename(file), pattern)
    )));
    if (matched && rule.note) notes.push(rule.note);
  }

  if (WORKSPACE_MARKERS.some((marker) => marker.id === "pnpm" && files.includes("pnpm-workspace.yaml"))) {
    notes.push("pnpm workspace detected.");
  }
  if (files.includes("lerna.json")) notes.push("Lerna monorepo detected.");
  if (files.includes("nx.json")) notes.push("Nx monorepo detected.");
  if (files.includes("turbo.json")) notes.push("Turborepo monorepo detected.");
  if (files.includes("go.work")) notes.push("Go workspace detected.");
  if (files.some((file) => file.endsWith(".sln"))) notes.push(".NET solution detected.");

  void fileSet;
  return unique(notes);
}

function runScript(packageManager: string, script: string): string {
  switch (packageManager) {
    case "yarn":
      return `yarn ${script}`;
    case "pnpm":
      return `pnpm ${script}`;
    case "bun":
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

function readJson(input: DetectionInput, file: string): Record<string, unknown> | undefined {
  const contents = input.readFile(file);
  if (!contents) return undefined;
  try {
    const parsed: unknown = JSON.parse(contents);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFiles(files: readonly string[]): string[] {
  return unique(files
    .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((file) => file.length > 0 && !isIgnoredPath(file)))
    .sort();
}

function isIgnoredPath(file: string): boolean {
  return file.split("/").some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
}

function hasFile(fileSet: Set<string>, file: string): boolean {
  return fileSet.has(file);
}

function hasFileAt(fileSet: Set<string>, root: string, file: string): boolean {
  return fileSet.has(join(root, file));
}

function join(root: string, file: string): string {
  return root === "." ? file : `${root}/${file}`;
}

function dirname(file: string): string {
  const index = file.lastIndexOf("/");
  return index === -1 ? "." : file.slice(0, index) || ".";
}

function basename(file: string): string {
  const index = file.lastIndexOf("/");
  return index === -1 ? file : file.slice(index + 1);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function uniqueName(base: string, used: Set<string>): string {
  const clean = base || "root";
  if (!used.has(clean)) {
    used.add(clean);
    return clean;
  }
  let index = 2;
  while (used.has(`${clean}-${index}`)) index += 1;
  const name = `${clean}-${index}`;
  used.add(name);
  return name;
}

function matchGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern, false).test(value);
}

function matchPathGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern, true).test(value);
}

function globToRegExp(pattern: string, pathMode: boolean): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += pathMode ? "[^/]*" : ".*";
      }
    } else if (char === "?") {
      source += pathMode ? "[^/]" : ".";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function markerPackageManagers(): readonly PackageManagerMarker[] {
  return PACKAGE_MANAGERS;
}
