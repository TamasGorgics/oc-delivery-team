import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTeamWorktree } from "../../src/state/worktrees";
import { openDatabase } from "../../src/state/db";
import { RunRepository } from "../../src/state/runs";

const directories: string[] = [];
const runsToAdvance = [
  { run: "run-one", name: "worker-one" },
  { run: "run-two", name: "worker-two" },
] as const;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-worktree-concurrency-"));
  directories.push(directory);
  return directory;
}

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
}

function runWorker(projectDir: string, runId: string, name: string): Promise<void> {
  const workerPath = path.resolve(process.cwd(), "test/fixtures/worktree-concurrency-worker.ts");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, projectDir, runId, name], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Worker ${name} exited ${code}: ${stderr}`));
    });
  });
}

describe("worktree database concurrency", () => {
  test("separate worktree workers trace and advance independent runs on the shared WAL database", async () => {
    const parentDir = tempDirectory();
    const mainRepoDir = path.join(parentDir, "main");
    mkdirSync(mainRepoDir, { recursive: true });
    git(mainRepoDir, ["init", "-q"]);
    git(mainRepoDir, ["config", "user.name", "Delivery Team Test"]);
    git(mainRepoDir, ["config", "user.email", "delivery-team-test@example.invalid"]);
    git(mainRepoDir, ["config", "commit.gpgsign", "false"]);
    git(mainRepoDir, ["commit", "--allow-empty", "--no-gpg-sign", "-m", "test baseline"]);

    const baseDir = path.join(parentDir, "worktrees");
    const first = createTeamWorktree({
      projectDir: mainRepoDir,
      baseDir,
      run: "run-one",
      name: "worker-one",
    });
    const second = createTeamWorktree({
      projectDir: mainRepoDir,
      baseDir,
      run: "run-two",
      name: "worker-two",
    });

    const dbPath = path.join(mainRepoDir, ".team", "team.db");
    const { db } = await openDatabase(dbPath);
    try {
      const runs = new RunRepository(db);
      for (const { run: runId, name } of runsToAdvance) {
        runs.createRun({
          id: runId,
          title: runId,
          sessionId: `${runId}-session`,
          projectDir: name === "worker-one" ? first.path : second.path,
          phase: "brainstorm",
        });
        runs.addTransition({ runId, from: null, to: "brainstorm", kind: "start" });
        runs.addNote({
          runId,
          kind: "decision",
          text: "human_approval: test fixture approved the specification",
          agent: "team-lead",
          sessionId: `${runId}-session`,
        });
      }
    } finally {
      db.close();
    }

    for (const { run } of runsToAdvance) {
      const runDirectory = path.join(mainRepoDir, ".team", "runs", run);
      mkdirSync(runDirectory, { recursive: true });
      writeFileSync(path.join(runDirectory, "brainstorm.md"), "# Brainstorm\n", "utf8");
      writeFileSync(
        path.join(runDirectory, "spec.md"),
        "# Spec\n\n<!-- team-footer -->\nSTATUS: APPROVED\n<!-- /team-footer -->\n",
        "utf8",
      );
      writeFileSync(path.join(runDirectory, "plan.md"), "# Plan\n", "utf8");
      writeFileSync(path.join(runDirectory, "impl-notes.md"), "# Implementation\n", "utf8");
      writeFileSync(
        path.join(runDirectory, "test-report.md"),
        "# Test\n\n<!-- team-footer -->\nRESULT: PASS\nCOMMAND: bun test\nEXIT: 0\n<!-- /team-footer -->\n",
        "utf8",
      );
      writeFileSync(
        path.join(runDirectory, "qa.md"),
        "# QA\n\n<!-- team-footer -->\nVERDICT: PASS\n<!-- /team-footer -->\n",
        "utf8",
      );
      writeFileSync(
        path.join(runDirectory, "adversary.md"),
        "# Adversary\n\n<!-- team-footer -->\nBLOCKERS: 0\n<!-- /team-footer -->\n",
        "utf8",
      );
      writeFileSync(path.join(runDirectory, "docs.md"), "# Docs\n", "utf8");
      writeFileSync(path.join(runDirectory, "retro.md"), "# Retro\n", "utf8");
    }

    await Promise.all([
      runWorker(first.path, "run-one", "worker-one"),
      runWorker(second.path, "run-two", "worker-two"),
    ]);

    const { db: verifyDb } = await openDatabase(dbPath);
    try {
      const runs = new RunRepository(verifyDb);
      for (const { run: runId } of runsToAdvance) {
        expect(runs.getRun(runId)).toMatchObject({ status: "closed", phase: "done" });
        expect(runs.getTransitions(runId)).toHaveLength(10);
        const events = verifyDb.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND kind = 'phase.advanced'",
          [runId],
        );
        expect(events?.count).toBe(9);
      }
    } finally {
      verifyDb.close();
    }
  });
});
