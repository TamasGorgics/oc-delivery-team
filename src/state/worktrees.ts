import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { isSafeRunId, resolveMainRepoDirectory } from "./paths";

const SAFE_WORKTREE_NAME = /^[a-z0-9-]{1,40}$/;
const GIT_TIMEOUT_MS = 30_000;
const GIT_LIST_TIMEOUT_MS = 3_000;

export interface CreatedTeamWorktree {
  readonly path: string;
  readonly branch: string;
  readonly run: string;
  readonly name: string;
}

export interface TeamWorktreeInfo extends CreatedTeamWorktree {
  readonly head: string;
  readonly locked?: string;
  readonly prunable?: string;
}

export interface TeamWorktreeList {
  readonly available: boolean;
  readonly worktrees: readonly TeamWorktreeInfo[];
  readonly error?: string;
}

export class WorktreeError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export function isSafeWorktreeName(value: string): boolean {
  return SAFE_WORKTREE_NAME.test(value);
}

export function createTeamWorktree(input: {
  readonly projectDir: string;
  readonly baseDir: string;
  readonly run: string;
  readonly name: string;
}): CreatedTeamWorktree {
  if (!isSafeRunId(input.run)) {
    throw new WorktreeError("The run id is not safe for a worktree branch or path.", "invalid_run");
  }
  if (!isSafeWorktreeName(input.name)) {
    throw new WorktreeError("name must match ^[a-z0-9-]{1,40}$.", "invalid_name");
  }

  const mainRepoDir = resolveMainRepoDirectory(input.projectDir);
  const repoResult = runGit(mainRepoDir, ["rev-parse", "--show-toplevel"]);
  if (!repoResult.ok) {
    const code = repoResult.message.startsWith("Git is unavailable:") ? "git_unavailable" : "not_git_repository";
    throw new WorktreeError(
      `${repoResult.message} Worktrees require a Git repository; continue with sequential development in place.`,
      code,
    );
  }
  const repoRoot = realpathSync(path.resolve(mainRepoDir));
  const requestedBaseDir = path.isAbsolute(input.baseDir)
    ? path.normalize(input.baseDir)
    : path.resolve(repoRoot, input.baseDir);
  const baseDir = resolveThroughExistingParent(requestedBaseDir);
  const worktreePath = path.join(baseDir, `${input.run}-${input.name}`);
  if (isWithin(repoRoot, worktreePath)) {
    throw new WorktreeError("worktrees.baseDir must resolve outside the main repository.", "invalid_base_dir");
  }
  if (pathExists(worktreePath)) {
    throw new WorktreeError(`Worktree path already exists: ${worktreePath}`, "worktree_conflict");
  }

  const branch = `team/${input.run}/${input.name}`;
  try {
    mkdirSync(requestedBaseDir, { recursive: true });
  } catch (error) {
    throw new WorktreeError(`Could not create worktree base directory: ${errorMessage(error)}`, "invalid_base_dir");
  }

  const result = spawnSync("git", ["worktree", "add", "-b", branch, worktreePath], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    const code = "code" in result.error && result.error.code === "ENOENT" ? "git_unavailable" : "git_failed";
    throw new WorktreeError(`Could not run git worktree add: ${errorMessage(result.error)}`, code);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "Git exited without a diagnostic.").trim();
    const code = /already exists|already checked out|already used by worktree/i.test(detail)
      ? "worktree_conflict"
      : "worktree_create_failed";
    throw new WorktreeError(`Could not create worktree: ${detail}`, code);
  }

  return { path: realpathSync(worktreePath), branch, run: input.run, name: input.name };
}

export function listTeamWorktrees(projectDir: string): TeamWorktreeList {
  const mainRepoDir = resolveMainRepoDirectory(projectDir);
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: mainRepoDir,
    encoding: "utf8",
    timeout: GIT_LIST_TIMEOUT_MS,
    maxBuffer: 1_000_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return {
      available: false,
      worktrees: [],
      error: errorMessage(result.error),
    };
  }
  if (result.status !== 0) {
    return {
      available: false,
      worktrees: [],
      error: (result.stderr || result.stdout || "Git worktree listing failed.").trim(),
    };
  }
  return { available: true, worktrees: parseTeamWorktrees(result.stdout) };
}

export function parseTeamWorktrees(porcelain: string): TeamWorktreeInfo[] {
  const entries: TeamWorktreeInfo[] = [];
  let current: {
    path?: string;
    head?: string;
    branch?: string;
    locked?: string;
    prunable?: string;
  } = {};

  const flush = (): void => {
    const pathValue = current.path;
    const head = current.head;
    const branchRef = current.branch;
    const prefix = "refs/heads/team/";
    if (pathValue && head && branchRef?.startsWith(prefix)) {
      const identity = branchRef.slice(prefix.length);
      const separator = identity.indexOf("/");
      if (separator > 0) {
        const run = identity.slice(0, separator);
        const name = identity.slice(separator + 1);
        if (isSafeRunId(run) && isSafeWorktreeName(name)) {
          entries.push({
            path: pathValue,
            head,
            branch: `team/${run}/${name}`,
            run,
            name,
            ...(current.locked ? { locked: current.locked } : {}),
            ...(current.prunable ? { prunable: current.prunable } : {}),
          });
        }
      }
    }
    current = {};
  };

  for (const line of porcelain.split(/\r?\n/)) {
    if (!line) {
      flush();
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1);
    if (key === "worktree") current.path = value;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "locked") current.locked = value || "locked";
    else if (key === "prunable") current.prunable = value || "prunable";
  }
  flush();
  return entries;
}

function runGit(
  cwd: string,
  args: readonly string[],
): { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly message: string } {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: 3_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) return { ok: false, message: `Git is unavailable: ${errorMessage(result.error)}` };
  if (result.status !== 0) {
    return { ok: false, message: (result.stderr || result.stdout || "Not a Git repository.").trim() };
  }
  return { ok: true, stdout: result.stdout };
}

function pathExists(value: string): boolean {
  try {
    lstatSync(value);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function resolveThroughExistingParent(value: string): string {
  const missing: string[] = [];
  let current = path.resolve(value);
  while (true) {
    try {
      return path.join(realpathSync(current), ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
