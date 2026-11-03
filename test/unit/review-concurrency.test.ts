import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import deliveryTeam from "../../src/index";
import { openDatabase } from "../../src/state/db";
import { RunRepository } from "../../src/state/runs";
import { createFakeContext } from "../fakes/ctx";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-review-concurrency-"));
  directories.push(directory);
  return directory;
}

interface WorkerResult {
  readonly stdout: string;
  readonly stderr: string;
}

function runWorker(
  projectDir: string,
  runId: string,
  role: "qa" | "adversary",
  reviewMode?: "default",
): Promise<WorkerResult> {
  const workerPath = path.resolve(process.cwd(), "test/fixtures/review-concurrency-worker.ts");
  const args = [workerPath, projectDir, runId, role, ...(reviewMode ? [reviewMode] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Review worker ${role} exited ${code}: ${stderr || stdout}`));
    });
  });
}

function footer(contents: string): void {
  expect(contents).toContain("<!-- team-footer -->");
  expect(contents.trimEnd().endsWith("<!-- /team-footer -->")).toBe(true);
}

describe("two-reviewer WAL concurrency", () => {
  test("qa and adversary child processes share one WAL database without contention", async () => {
    const projectDir = tempDirectory();
    const rootDir = path.join(projectDir, ".team");
    const dbPath = path.join(rootDir, "team.db");
    const runId = "run-review-concurrency";

    const { db } = await openDatabase(dbPath);
    try {
      const runs = new RunRepository(db);
      runs.createRun({
        id: runId,
        title: "Parallel review concurrency",
        sessionId: "lead-session",
        projectDir,
        phase: "brainstorm",
      });
      runs.addTransition({ runId, from: null, to: "brainstorm", kind: "start" });
      runs.addTransition({ runId, from: "test", to: "qa", kind: "advance" });
      runs.updatePhase(runId, "qa");
    } finally {
      db.close();
    }
    mkdirSync(path.join(rootDir, "runs", runId), { recursive: true });

    const results = await Promise.all([
      runWorker(projectDir, runId, "qa"),
      runWorker(projectDir, runId, "adversary"),
    ]);
    for (const result of results) {
      expect(result.stderr).not.toContain("SQLITE_BUSY");
      expect(result.stderr).not.toContain("database is locked");
      expect(result.stderr).not.toContain("ON CONFLICT");
      expect(result.stderr).not.toContain("did not infer");
    }

    const { db: verifyDb } = await openDatabase(dbPath);
    try {
      const runs = new RunRepository(verifyDb);
      expect(runs.getLoop(runId, "qa", "qa")).toBe(1);
      expect(runs.getLoop(runId, "qa", "adversary")).toBe(1);
      expect(runs.getLoop(runId, "qa", "")).toBe(0);
      expect(runs.getLoops(runId)).toEqual([
        { run_id: runId, phase: "qa", role: "adversary", count: 1 },
        { run_id: runId, phase: "qa", role: "qa", count: 1 },
      ]);

      const notes = runs.listNotes(runId).filter((note) => note.kind === "finding");
      expect(notes).toHaveLength(2);
      expect(notes.map((note) => note.agent).sort()).toEqual(["adversary", "qa"]);
      expect(notes.map((note) => note.text).sort()).toEqual(["adversary finding", "qa finding"]);

      const transitions = runs.getTransitions(runId);
      expect(transitions.map((row) => row.to_phase)).toContain("qa");
      expect(runs.countPhaseEntries(runId, "qa")).toBe(1);
    } finally {
      verifyDb.close();
    }

    const qaContents = readFileSync(path.join(rootDir, "runs", runId, "qa.md"), "utf8");
    const adversaryContents = readFileSync(path.join(rootDir, "runs", runId, "adversary.md"), "utf8");
    expect(qaContents).toContain("VERDICT: PASS");
    expect(adversaryContents).toContain("BLOCKERS: 0");
    footer(qaContents);
    footer(adversaryContents);

    const fake = createFakeContext({
      projectDirectory: projectDir,
      options: { reviews: { parallel: true } },
    });
    const cleanup = await deliveryTeam.setup(fake.context);
    if (typeof cleanup !== "function") throw new Error("Plugin setup did not return a cleanup function.");
    try {
      const statusResult = await fake.invokeTool(
        "team_status",
        { run: runId },
        { sessionID: "lead-session", agent: "team-lead", id: "lead-status" },
      );
      const status = (statusResult.output ?? {}) as Record<string, any>;
      expect(status.ok).toBe(true);
      expect(status.phase).toBe("qa");
      expect(status.gate).toMatchObject({ ok: true, code: "ok" });
      expect(status.review_wave).toMatchObject({
        enabled: true,
        active: true,
        ready: true,
        phase: "qa",
        generation: 1,
      });
      expect(status.review_wave.members.map((member: any) => member.role)).toEqual(["qa", "adversary"]);
      expect(status.review_wave.members.map((member: any) => member.gate?.ok)).toEqual([true, true]);

      const advanceResult = await fake.invokeTool(
        "team_advance",
        { run: runId },
        { sessionID: "lead-session", agent: "team-lead", id: "lead-advance" },
      );
      const advanced = (advanceResult.output ?? {}) as Record<string, any>;
      expect(advanced).toMatchObject({ ok: true, from: "qa", to: "docs", phase: "docs" });
    } finally {
      await cleanup();
    }

    const { db: finalDb } = await openDatabase(dbPath);
    try {
      const runs = new RunRepository(finalDb);
      expect(runs.getRun(runId)?.phase).toBe("docs");
      expect(runs.getTransitions(runId).map((row) => row.to_phase)).not.toContain("adversary");
      const completed = finalDb.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND kind = 'review.wave.completed'",
        [runId],
      );
      expect(completed?.count).toBe(1);
    } finally {
      finalDb.close();
    }
  });

  test("the default config still runs the review wave across two reviewer processes", async () => {
    const projectDir = tempDirectory();
    const rootDir = path.join(projectDir, ".team");
    const dbPath = path.join(rootDir, "team.db");
    const runId = "run-review-default-concurrency";

    const { db } = await openDatabase(dbPath);
    try {
      const runs = new RunRepository(db);
      runs.createRun({
        id: runId,
        title: "Default parallel review concurrency",
        sessionId: "lead-session",
        projectDir,
        phase: "brainstorm",
      });
      runs.addTransition({ runId, from: null, to: "brainstorm", kind: "start" });
      runs.addTransition({ runId, from: "test", to: "qa", kind: "advance" });
      runs.updatePhase(runId, "qa");
    } finally {
      db.close();
    }
    mkdirSync(path.join(rootDir, "runs", runId), { recursive: true });

    const results = await Promise.all([
      runWorker(projectDir, runId, "qa", "default"),
      runWorker(projectDir, runId, "adversary", "default"),
    ]);
    for (const result of results) {
      expect(result.stderr).not.toContain("SQLITE_BUSY");
      expect(result.stderr).not.toContain("database is locked");
      expect(result.stderr).not.toContain("ON CONFLICT");
      expect(result.stderr).not.toContain("did not infer");
      expect(result.stderr).not.toContain("Expected an active review wave");
    }

    const qaContents = readFileSync(path.join(rootDir, "runs", runId, "qa.md"), "utf8");
    const adversaryContents = readFileSync(path.join(rootDir, "runs", runId, "adversary.md"), "utf8");
    expect(qaContents).toContain("VERDICT: PASS");
    expect(adversaryContents).toContain("BLOCKERS: 0");
    footer(qaContents);
    footer(adversaryContents);

    const { db: verifyDb } = await openDatabase(dbPath);
    try {
      const runs = new RunRepository(verifyDb);
      expect(runs.getLoops(runId)).toEqual([
        { run_id: runId, phase: "qa", role: "adversary", count: 1 },
        { run_id: runId, phase: "qa", role: "qa", count: 1 },
      ]);
    } finally {
      verifyDb.close();
    }

    const fake = createFakeContext({ projectDirectory: projectDir });
    const cleanup = await deliveryTeam.setup(fake.context);
    if (typeof cleanup !== "function") throw new Error("Plugin setup did not return a cleanup function.");
    try {
      const statusResult = await fake.invokeTool(
        "team_status",
        { run: runId },
        { sessionID: "lead-session", agent: "team-lead", id: "lead-status" },
      );
      const status = (statusResult.output ?? {}) as Record<string, any>;
      expect(status.review_wave).toMatchObject({
        enabled: true,
        active: true,
        ready: true,
        phase: "qa",
        generation: 1,
      });
      expect(status.review_wave.members.map((member: any) => member.role)).toEqual(["qa", "adversary"]);
      expect(status.review_wave.members.map((member: any) => member.gate?.ok)).toEqual([true, true]);

      const advanceResult = await fake.invokeTool(
        "team_advance",
        { run: runId },
        { sessionID: "lead-session", agent: "team-lead", id: "lead-advance" },
      );
      expect((advanceResult.output ?? {}) as Record<string, any>)
        .toMatchObject({ ok: true, from: "qa", to: "docs", phase: "docs" });
    } finally {
      await cleanup();
    }

    const { db: finalDb } = await openDatabase(dbPath);
    try {
      const completed = finalDb.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND kind = 'review.wave.completed'",
        [runId],
      );
      expect(completed?.count).toBe(1);
      expect(new RunRepository(finalDb).getTransitions(runId).map((row) => row.to_phase)).not.toContain("adversary");
    } finally {
      finalDb.close();
    }
  });
});
