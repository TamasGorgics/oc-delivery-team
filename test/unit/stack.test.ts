import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectStack } from "../../src/stack/detect";
import { MARKER_RULES, type MarkerRule } from "../../src/stack/markers";
import {
  DEFAULT_DOC_GLOBS,
  DEFAULT_TEST_GLOBS,
  findHumanOwnedConflicts,
  mergeStackProfile,
  parseStackProfile,
  profileHasTestCommand,
  resolveScopeGlobs,
  type StackComponent,
  type StackProfile,
} from "../../src/stack/profile";
import { resolveStackProfile } from "../../src/stack/resolve";
import { StackService } from "../../src/stack/service";
import { openDatabase } from "../../src/state/db";
import { RunRepository } from "../../src/state/runs";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-stack-"));
  directories.push(directory);
  return directory;
}

function profile(raw: unknown): StackProfile {
  const parsed = parseStackProfile(raw);
  if (!parsed.profile) throw new Error(`Invalid test profile: ${JSON.stringify(parsed.diagnostics)}`);
  return parsed.profile;
}

function component(overrides: Partial<StackComponent> = {}): StackComponent {
  return {
    name: "root",
    root: ".",
    languages: [],
    frameworks: [],
    packageManager: null,
    commands: {
      install: null,
      build: null,
      test: null,
      lint: null,
      format: null,
      typecheck: null,
      run: null,
    },
    globs: { source: [], tests: [], docs: [], ignore: [] },
    ...overrides,
  };
}

interface Fixture {
  readonly files: string[];
  readonly contents: Record<string, string>;
}

function markerFixture(rule: MarkerRule): Fixture {
  const files: string[] = [];
  const contents: Record<string, string> = {};
  for (const manifest of rule.manifests) {
    const file = manifest.replace(/\*/g, "sample");
    files.push(file);
  }

  if (rule.manifests.includes("package.json")) {
    contents["package.json"] = JSON.stringify({
      name: "fixture",
      scripts: { test: "repo-test", build: "repo-build", lint: "repo-lint" },
    });
  }
  if (rule.manifests.includes("Makefile") || rule.manifests.includes("makefile")) {
    contents["Makefile"] = "test:\n\trepo test\nbuild:\n\trepo build\n";
  }
  if (rule.manifests.includes("justfile") || rule.manifests.includes("Justfile")) {
    contents["justfile"] = "test:\n  repo test\nbuild:\n  repo build\n";
  }
  if (rule.manifests.includes("Taskfile.yml") || rule.manifests.includes("Taskfile.yaml")) {
    contents["Taskfile.yml"] = "tasks:\n  test:\n    cmds:\n      - repo test\n";
  }
  if (rule.id === "ci") {
    contents[".github/workflows/sample.yml"] = "jobs:\n  test:\n    steps:\n      - run: repo-ci test\n";
  }
  return { files, contents };
}

function detectFixture(fixture: Fixture): StackProfile {
  return detectStack({
    files: fixture.files,
    readFile: (file) => fixture.contents[file],
  });
}

describe("marker-table stack detection", () => {
  test("every marker row is detected from its manifest", () => {
    for (const rule of MARKER_RULES) {
      const detected = detectFixture(markerFixture(rule));
      if (rule.kind === "tooling") {
        expect(detected.notes ?? "").toContain(rule.note as string);
        continue;
      }

      expect(detected.components.length).toBeGreaterThan(0);
      const matched = detected.components.some((entry) => (
        rule.languages.some((language) => entry.languages.includes(language)) ||
        (rule.frameworks ?? []).some((framework) => entry.frameworks.includes(framework))
      ));
      expect({ rule: rule.id, matched, components: detected.components }).toMatchObject({ rule: rule.id, matched: true });
    }
  });

  test("javascript and typescript merge into one component with lockfile package managers", () => {
    const files = [
      "package.json",
      "bun.lock",
      "tsconfig.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "package-lock.json",
      "src/a.ts",
    ];
    const detected = detectStack({
      files,
      readFile: (file) => file === "package.json"
        ? JSON.stringify({ scripts: { test: "bun test", build: "bun run build" } })
        : undefined,
    });
    expect(detected.components).toHaveLength(1);
    expect(detected.components[0]?.languages).toEqual(["javascript", "typescript"]);
    expect(detected.components[0]?.packageManager).toBe("pnpm");
    expect(detected.components[0]?.commands).toMatchObject({
      install: "pnpm install",
      test: "pnpm test",
      build: "pnpm build",
    });
  });

  test("detects monorepos as multiple components", () => {
    const detected = detectStack({
      files: [
        "package.json",
        "pnpm-workspace.yaml",
        "packages/api/package.json",
        "packages/web/package.json",
      ],
      readFile: (file) => file.endsWith("package.json") ? JSON.stringify({ name: file }) : undefined,
    });
    expect(detected.components.map((entry) => `${entry.name}@${entry.root}`)).toEqual([
      "root@.",
      "api@packages/api",
      "web@packages/web",
    ]);
    expect(detected.notes).toContain("pnpm workspace detected.");
  });

  test("detects multi-language repositories as separate components", () => {
    const detected = detectStack({
      files: ["go.mod", "main.go", "pyproject.toml", "app.py", "Dockerfile"],
      readFile: () => undefined,
    });
    expect(detected.components.map((entry) => entry.languages[0]).sort()).toEqual(["go", "python"]);
    expect(detected.components.find((entry) => entry.languages.includes("go"))?.commands.test).toBe("go test ./...");
    expect(detected.components.find((entry) => entry.languages.includes("python"))?.commands.test).toBe("python -m pytest");
    expect(detected.notes).toContain("Container definitions detected.");
  });

  test("prefers repo-declared commands over ecosystem defaults", () => {
    const scripts = detectStack({
      files: ["package.json", "src/a.ts", "Makefile", ".github/workflows/ci.yml"],
      readFile: (file) => {
        if (file === "package.json") return JSON.stringify({ scripts: { test: "repo-test" } });
        if (file === "Makefile") return "test:\n\tmake-test\n";
        if (file === ".github/workflows/ci.yml") return "steps:\n  - run: ci-test\n";
        return undefined;
      },
    });
    expect(scripts.components[0]?.commands.test).toBe("npm run test");

    const make = detectStack({
      files: ["pyproject.toml", "Makefile"],
      readFile: (file) => file === "Makefile" ? "test:\n\tmake-test\n" : undefined,
    });
    expect(make.components[0]?.commands.test).toBe("make test");

    const ci = detectStack({
      files: ["go.mod", ".github/workflows/ci.yml"],
      readFile: (file) => file === ".github/workflows/ci.yml" ? "steps:\n  - run: ./scripts/test.sh\n" : undefined,
    });
    expect(ci.components[0]?.commands.test).toBe("./scripts/test.sh");
  });

  test("returns an empty profile for an empty directory", () => {
    expect(detectStack({ files: [], readFile: () => undefined })).toEqual({
      version: 1,
      source: "detected",
      components: [],
    });
  });

  test("performs no command execution or network access and only uses provided reads", () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const spawnSpy = spyOn(Bun, "spawn");
    const spawnSyncSpy = spyOn(Bun, "spawnSync");
    const readFile = mock((file: string) => file === "package.json" ? JSON.stringify({ scripts: { test: "x" } }) : undefined);
    try {
      detectStack({ files: ["package.json", "src/a.ts"], readFile });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(spawnSyncSpy).not.toHaveBeenCalled();
      expect(readFile).toHaveBeenCalled();
      for (const call of readFile.mock.calls) {
        expect(typeof call[0]).toBe("string");
        expect(String(call[0]).startsWith("/")).toBe(false);
      }
    } finally {
      fetchSpy.mockRestore();
      spawnSpy.mockRestore();
      spawnSyncSpy.mockRestore();
    }
  });
});

describe("Stack Profile schema and merge patch", () => {
  test("validates profiles, defaults, and unknown fields", () => {
    const parsed = parseStackProfile({
      version: 1,
      components: [{ name: "api", root: "services/api", commands: { test: "api test", lint: null } }],
      shell: "bash",
      extra: true,
    });
    expect(parsed.diagnostics).toEqual([
      { path: "extra", message: "Unknown stack profile field; ignored.", severity: "warning" },
    ]);
    expect(parsed.profile).toEqual({
      version: 1,
      source: "detected",
      components: [{
        ...component(),
        name: "api",
        root: "services/api",
        commands: { ...component().commands, test: "api test" },
      }],
      shell: "bash",
    });
    expect(parseStackProfile(undefined).profile).toEqual({ version: 1, source: "detected", components: [] });
  });

  test("rejects invalid versions, sources, commands, and components", () => {
    expect(parseStackProfile({ version: 2 }).diagnostics[0]).toMatchObject({ path: "version", severity: "error" });
    expect(parseStackProfile({ source: "robot" }).diagnostics[0]).toMatchObject({ path: "source", severity: "error" });
    expect(parseStackProfile({ components: "nope" }).diagnostics[0]).toMatchObject({ path: "components", severity: "error" });
    expect(parseStackProfile({ components: [{}] }).diagnostics).toContainEqual({
      path: "components[0].name",
      message: "Must be a non-empty string.",
      severity: "error",
    });
    expect(parseStackProfile({ components: [{ name: "x", commands: { test: 1 } }] }).diagnostics).toContainEqual({
      path: "components[0].commands.test",
      message: "Command must be a string or null.",
      severity: "error",
    });
    expect(parseStackProfile({ components: [{ name: "x", globs: { wat: [] } }] }).diagnostics[0]).toMatchObject({
      path: "components[0].globs.wat",
      severity: "warning",
    });
  });

  test("merges objects, replaces arrays, and removes null keys", () => {
    const base = profile({ notes: "old", components: [{ name: "root" }] });
    const merged = mergeStackProfile(base, {
      notes: null,
      shell: "zsh",
      components: [{ name: "api", commands: { test: "api-test" } }],
    });
    expect(merged.merged).toMatchObject({
      shell: "zsh",
      components: [expect.objectContaining({ name: "api" })],
    });
    expect(merged.merged?.notes).toBeUndefined();
    expect(mergeStackProfile(base, []).diagnostics[0]).toMatchObject({ path: "", severity: "error" });
  });

  test("finds human-owned field conflicts recursively", () => {
    const human = { components: [{ name: "api", commands: { test: "human-test" } }], notes: "owned" };
    expect(findHumanOwnedConflicts(human, { components: [{ name: "api", commands: { test: "other" } }] }))
      .toEqual(["components"]);
    expect(findHumanOwnedConflicts({ a: { b: "c" }, d: "e" }, { a: { b: "x" }, d: "y" }))
      .toEqual(["a.b", "d"]);
  });

  test("resolves default test and docs globs only when components omit them", () => {
    const emptyGlobs = resolveScopeGlobs(profile({ components: [{ name: "root" }] }));
    expect(emptyGlobs.defaulted).toBe(true);
    expect(emptyGlobs.tests).toEqual([...DEFAULT_TEST_GLOBS]);
    expect(emptyGlobs.docs).toEqual([...DEFAULT_DOC_GLOBS]);

    const explicit = resolveScopeGlobs(profile({
      components: [{
        name: "root",
        globs: { tests: ["check/**"], docs: ["manual/**"] },
      }],
    }));
    expect(explicit).toEqual({ tests: ["check/**"], docs: ["manual/**"], defaulted: false });

    const empty = resolveScopeGlobs(profile({ components: [] }));
    expect(empty.defaulted).toBe(true);
    expect(empty.tests).toEqual([...DEFAULT_TEST_GLOBS]);
  });

  test("detects whether any component has a test command", () => {
    expect(profileHasTestCommand(profile({ components: [] }))).toBe(false);
    expect(profileHasTestCommand(profile({ components: [{ name: "root", commands: { test: "x" } }] }))).toBe(true);
    expect(profileHasTestCommand(profile({ components: [{ name: "root", commands: { test: null } }] }))).toBe(false);
  });
});

describe("Stack Profile resolution order", () => {
  const detected = profile({ components: [{ name: "detected", commands: { test: "detected-test" } }] });
  const stored = { version: 1, source: "researcher", components: [{ name: "stored", commands: { test: "stored-test" } }] };
  const override = { components: [{ name: "override", commands: { test: "override-test" } }] };

  test("human stack.json wins over every other layer", () => {
    const human = { version: 1, source: "human", components: [{ name: "human", commands: { test: "human-test" } }] };
    const resolution = resolveStackProfile({ human, override, stored, detected, detect: true });
    expect(resolution).toMatchObject({ layer: "human", sources: ["human"] });
    expect(resolution.profile.components[0]?.name).toBe("human");
    expect(resolution.profile.source).toBe("human");
  });

  test("config overrides win over stored and detected and record their sources", () => {
    const resolution = resolveStackProfile({ override, stored, detected, detect: true });
    expect(resolution.layer).toBe("override");
    expect(resolution.sources).toEqual(["override", "run"]);
    expect(resolution.profile.components[0]?.name).toBe("override");
    expect(resolution.profile.source).toBe("human");
  });

  test("a run-stored researcher profile wins over detection", () => {
    const resolution = resolveStackProfile({ stored, detected, detect: true });
    expect(resolution.layer).toBe("run");
    expect(resolution.sources).toEqual(["run"]);
    expect(resolution.profile.components[0]?.name).toBe("stored");
    expect(resolution.profile.source).toBe("researcher");
  });

  test("detected data is used when no higher layer exists", () => {
    const resolution = resolveStackProfile({ detected, detect: true });
    expect(resolution.layer).toBe("detected");
    expect(resolution.sources).toEqual(["detected"]);
    expect(resolution.profile.source).toBe("detected");
  });

  test("falls back to an empty profile when detection is disabled or unavailable", () => {
    expect(resolveStackProfile({ detected, detect: false })).toMatchObject({
      layer: "empty",
      sources: ["empty"],
      profile: { version: 1, source: "detected", components: [] },
    });
    expect(resolveStackProfile({ detect: true })).toMatchObject({ layer: "empty", sources: ["empty"] });
  });

  test("keeps diagnostics from an invalid human profile and continues down the order", () => {
    const resolution = resolveStackProfile({
      human: { version: 1, components: "broken" },
      detected,
      detect: true,
    });
    expect(resolution.layer).toBe("detected");
    expect(resolution.diagnostics[0]).toMatchObject({ path: "components", severity: "error" });
  });
});

describe("StackService", () => {
  test("detects, persists, and reloads the run profile", async () => {
    const projectDir = tempDir();
    const rootDir = path.join(projectDir, ".team");
    writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }), "utf8");
    writeFileSync(path.join(projectDir, "bun.lock"), "", "utf8");

    const { db } = await openDatabase(path.join(rootDir, "team.db"));
    try {
      const runs = new RunRepository(db);
      const run = runs.createRun({
        id: "run-1",
        title: "Stack",
        sessionId: "session-1",
        projectDir,
        phase: "brainstorm",
      });
      const service = new StackService({ rootDir, projectDir, config: { detect: true }, runs });

      const project = service.resolveForProject();
      expect(project.layer).toBe("detected");
      expect(project.profile.components[0]?.commands.test).toBe("bun run test");

      const initial = service.resolveForRun(run, false);
      service.persist(run, initial.profile);
      expect(JSON.parse(readFileSync(path.join(rootDir, "runs", "run-1", "stack.json"), "utf8")))
        .toEqual(initial.profile);
      expect(runs.getRun("run-1")?.stack_json).toContain("components");

      const stored = service.resolveForRun(runs.getRun("run-1") ?? run, false);
      expect(stored.layer).toBe("run");
      expect(stored.profile.source).toBe("researcher");

      const update = service.updateRun(run, {
        components: [{ name: "root", commands: { test: "custom test", run: "custom run" } }],
      });
      expect(update.ok).toBe(true);
      expect(update.profile?.source).toBe("researcher");
      expect(update.profile?.components[0]?.commands.test).toBe("custom test");
      expect(service.resolveForRun(runs.getRun("run-1") ?? run, false).profile.components[0]?.commands.test)
        .toBe("custom test");

      writeFileSync(path.join(projectDir, "custom.txt"), "x");
      const refreshed = service.resolveForRun(runs.getRun("run-1") ?? run, true);
      expect(refreshed.layer).toBe("detected");
    } finally {
      db.close();
    }
  });

  test("honors detection=false and refuses to override human-owned fields", async () => {
    const projectDir = tempDir();
    const rootDir = path.join(projectDir, ".team");
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(path.join(projectDir, "go.mod"), "module example.com/x\n", "utf8");
    writeFileSync(path.join(rootDir, "stack.json"), JSON.stringify({
      version: 1,
      source: "human",
      components: [{ name: "human", commands: { test: "human test" } }],
    }), "utf8");

    const { db } = await openDatabase(path.join(rootDir, "team.db"));
    try {
      const runs = new RunRepository(db);
      const run = runs.createRun({
        id: "run-1",
        title: "Human stack",
        sessionId: "session-1",
        projectDir,
        phase: "brainstorm",
      });

      const human = new StackService({ rootDir, projectDir, config: { detect: true }, runs }).resolveForRun(run, false);
      expect(human.layer).toBe("human");
      expect(human.profile.components[0]?.commands.test).toBe("human test");

      const conflict = new StackService({ rootDir, projectDir, config: { detect: true }, runs })
        .updateRun(run, { components: [{ name: "other", commands: { test: "other" } }] });
      expect(conflict.ok).toBe(false);
      expect(conflict.conflicts).toEqual(["components"]);
      expect(conflict.error).toContain("human-owned");

      const disabled = new StackService({ rootDir, projectDir, config: { detect: false }, runs });
      expect(disabled.resolveForProject().profile.components[0]?.commands.test).toBe("human test");
    } finally {
      db.close();
    }
  });
});
