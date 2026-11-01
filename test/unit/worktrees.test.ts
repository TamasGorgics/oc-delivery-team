import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTeamCli } from "../../src/cli/team";
import deliveryTeam from "../../src/index";
import { isSafeWorktreeName } from "../../src/state/worktrees";
import { createFakeContext, type FakeContextHarness } from "../fakes/ctx";

interface Harness {
  readonly fake: FakeContextHarness;
  readonly projectDir: string;
  readonly rootDir: string;
}

type ToolOutput = Record<string, any>;

const directories: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // Worktree test teardown is best-effort.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-worktrees-"));
  directories.push(directory);
  return directory;
}

function createGitProject(): { readonly parentDir: string; readonly projectDir: string } {
  const parentDir = tempDirectory();
  const projectDir = path.join(parentDir, "main");
  mkdirSync(projectDir, { recursive: true });
  git(projectDir, ["init", "-q"]);
  git(projectDir, ["config", "user.name", "Delivery Team Test"]);
  git(projectDir, ["config", "user.email", "delivery-team-test@example.invalid"]);
  git(projectDir, ["config", "commit.gpgsign", "false"]);
  git(projectDir, ["commit", "--allow-empty", "--no-gpg-sign", "-m", "test baseline"]);
  return { parentDir, projectDir };
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

async function setup(
  projectDir: string,
  worktrees: { readonly enabled: boolean; readonly baseDir: string },
): Promise<Harness> {
  const fake = createFakeContext({ projectDirectory: projectDir, options: { worktrees } });
  const cleanup = await deliveryTeam.setup(fake.context);
  if (typeof cleanup !== "function") throw new Error("Expected plugin setup to return a cleanup function.");
  cleanups.push(cleanup);
  return { fake, projectDir, rootDir: path.join(projectDir, ".team") };
}

async function call(
  harness: Harness,
  name: string,
  input: unknown = {},
  context: { readonly sessionID?: string; readonly agent?: string; readonly id?: string } = {},
): Promise<ToolOutput> {
  const result = await harness.fake.invokeTool(name, input, context);
  return (result.output ?? {}) as ToolOutput;
}

async function cli(cwd: string, argv: readonly string[]): Promise<{ readonly code: number; readonly output: string }> {
  let output = "";
  const code = await runTeamCli(argv, {
    cwd,
    stdout: (text) => { output += text; },
    stderr: (text) => { output += text; },
  });
  return { code, output };
}

describe("team_worktree", () => {
  test("accepts only short lowercase alphanumeric and hyphen names", () => {
    expect(isSafeWorktreeName("task-1")).toBe(true);
    expect(isSafeWorktreeName("a".repeat(40))).toBe(true);
    expect(isSafeWorktreeName("a".repeat(41))).toBe(false);
    expect(isSafeWorktreeName("Task-One")).toBe(false);
    expect(isSafeWorktreeName("task/one")).toBe(false);
  });

  test("is registered only when enabled and creates unique branches and paths", async () => {
    const { parentDir, projectDir } = createGitProject();
    const baseDir = "../worktrees";
    const harness = await setup(projectDir, { enabled: true, baseDir });
    expect(harness.fake.state.tools.has("team_worktree")).toBe(true);

    const started = await call(harness, "team_start", { title: "Parallel delivery" });
    const run = started.run as string;
    const invalidName = await call(harness, "team_worktree", { run, name: "task/one" });
    expect(invalidName).toMatchObject({ ok: false, code: "invalid_name" });

    const first = await call(harness, "team_worktree", { run, name: "task-one" });
    expect(first).toMatchObject({
      ok: true,
      run,
      name: "task-one",
      path: realpathSync(path.join(parentDir, "worktrees", `${run}-task-one`)),
      branch: `team/${run}/task-one`,
    });
    const second = await call(harness, "team_worktree", { run, name: "task-two" });
    expect(second).toMatchObject({
      ok: true,
      path: realpathSync(path.join(parentDir, "worktrees", `${run}-task-two`)),
      branch: `team/${run}/task-two`,
    });

    expect(existsSync(first.path as string)).toBe(true);
    expect(existsSync(second.path as string)).toBe(true);
    expect(git(first.path as string, ["branch", "--show-current"])).toBe(`team/${run}/task-one`);
    expect(git(second.path as string, ["branch", "--show-current"])).toBe(`team/${run}/task-two`);

    const duplicate = await call(harness, "team_worktree", { run, name: "task-one" });
    expect(duplicate).toMatchObject({ ok: false, code: "worktree_conflict" });

    const listed = await cli(projectDir, ["runs", "--root", harness.rootDir]);
    expect(listed.code).toBe(0);
    const payload = JSON.parse(listed.output);
    expect(payload).toMatchObject({
      worktree_status: "available",
      worktree_count: 2,
      worktrees: [
        { run, name: "task-one", branch: `team/${run}/task-one`, run_status: "open" },
        { run, name: "task-two", branch: `team/${run}/task-two`, run_status: "open" },
      ],
    });
    // Creation and listing do not remove the worktrees; humans clean them up.
    expect(git(projectDir, ["worktree", "list", "--porcelain"]).match(/worktree /g)).toHaveLength(3);
  });

  test("returns a clear non-Git fallback error and registers no tool when disabled", async () => {
    const projectDir = tempDirectory();
    const disabled = await setup(projectDir, { enabled: false, baseDir: "../worktrees" });
    expect(disabled.fake.state.tools.has("team_worktree")).toBe(false);
    await cleanups.pop()?.();

    const enabled = await setup(projectDir, { enabled: true, baseDir: "../worktrees" });
    const started = await call(enabled, "team_start", { title: "No Git project" });
    const result = await call(enabled, "team_worktree", {
      run: started.run,
      name: "task-one",
    });
    expect(result).toMatchObject({ ok: false, code: "not_git_repository" });
    expect(result.error).toContain("sequential development");

    const listed = await cli(projectDir, ["runs", "--root", enabled.rootDir]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.output)).toMatchObject({ worktree_status: "unavailable", worktrees: [] });
  });
});
