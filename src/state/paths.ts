import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SAFE_RUN_ID = /^[0-9a-z](?:[0-9a-z-]*[0-9a-z])?$/;
const MAX_RUN_ID_LENGTH = 120;

/**
 * Worktrees share one .team directory. Resolve the data root against the main
 * repository when git can tell us where it is, otherwise keep the project dir.
 */
export function resolveMainRepoDirectory(projectDir: string): string {
  const absolute = runGit(projectDir, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const commonDir = absolute ?? runGit(projectDir, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) return projectDir;

  const resolved = path.isAbsolute(commonDir) ? path.normalize(commonDir) : path.resolve(projectDir, commonDir);
  return path.basename(resolved) === ".git" ? path.dirname(resolved) : resolved;
}

export function resolveDataRoot(projectDir: string, root: string, mainRepoDir = resolveMainRepoDirectory(projectDir)): string {
  return path.isAbsolute(root) ? path.normalize(root) : path.resolve(mainRepoDir, root);
}

export function createRunId(title: string, timestamp = Date.now()): string {
  const slug = slugify(title);
  return `${timestamp.toString(36)}-${slug}`;
}

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "run";
}

export function isSafeRunId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_RUN_ID_LENGTH && SAFE_RUN_ID.test(value) && !value.includes("..");
}

export function runDirectory(rootDir: string, runId: string): string {
  if (!isSafeRunId(runId)) throw new Error(`Invalid run id: ${JSON.stringify(runId)}`);
  return path.join(rootDir, "runs", runId);
}

export function runArtifactPath(rootDir: string, runId: string, artifact: string): string {
  if (path.basename(artifact) !== artifact || artifact === "." || artifact === "..") {
    throw new Error(`Invalid artifact name: ${JSON.stringify(artifact)}`);
  }
  return path.join(runDirectory(rootDir, runId), artifact);
}

export function ensureRunDirectory(rootDir: string, runId: string): string {
  const directory = runDirectory(rootDir, runId);
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function ensureDirectory(directory: string): string {
  mkdirSync(directory, { recursive: true });
  return directory;
}

function runGit(projectDir: string, args: readonly string[]): string | undefined {
  try {
    const result = spawnSync("git", [...args], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return undefined;
    const value = result.stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
