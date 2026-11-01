import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTeamCli } from "../../src/cli/team";
import { buildEvalReport } from "../../src/evals/report";
import { prepareOpenCodeProject } from "../../src/evals/runner";
import { loadEvalModelPreset, loadEvalTask, listEvalTaskNames } from "../../src/evals/tasks";
import type { EvalRunner, EvalRunnerInput, EvalRunnerResult } from "../../src/evals/runner";
import { openDatabase } from "../../src/state/db";
import { EvalRepository, type EvalRunRow } from "../../src/state/evals";
import { RunRepository } from "../../src/state/runs";
import { Tracer } from "../../src/state/trace";
import { StackService } from "../../src/stack/service";
import { tokenizeStackCommand } from "../../src/evals/criteria";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempProject(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-evals-"));
  directories.push(directory);
  return directory;
}

class StubRunner implements EvalRunner {
  async run(input: EvalRunnerInput): Promise<EvalRunnerResult> {
    mkdirSync(path.join(input.fixtureDirectory, "src"), { recursive: true });
    writeFileSync(
      path.join(input.fixtureDirectory, "src", "slug.ts"),
      `export function slugifyTitle(value: string): string {\n`
        + `  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}\n`,
      "utf8",
    );

    const { db } = await openDatabase(path.join(input.dataRoot, "team.db"));
    try {
      const runs = new RunRepository(db);
      runs.createRun({
        id: "eval-stub-run",
        title: input.taskName,
        sessionId: "eval-stub-session",
        projectDir: input.fixtureDirectory,
        phase: "done",
      });
      runs.closeRun("eval-stub-run");
      runs.incrementLoop("eval-stub-run", "implement");
      db.run(
        `INSERT INTO messages (id, session_id, run_id, agent, model, tokens_in, tokens_out, cost, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["eval-message", "eval-stub-session", "eval-stub-run", "developer", "test/provider-model", 10, 5, 0.25, new Date().toISOString()],
      );
      new Tracer(db).event("models.snapshot", {
        roles: {
          developer: {
            effectiveModel: "test/provider-model",
            model: "test/provider-model",
            params: { temperature: 0.1 },
          },
        },
      });
    } finally {
      db.close();
    }
    return { exitCode: 0, timedOut: false, durationMs: 25 };
  }
}

async function cli(
  cwd: string,
  argv: readonly string[],
  runner?: EvalRunner,
): Promise<{ readonly code: number; readonly output: string }> {
  let output = "";
  const code = await runTeamCli(argv, {
    cwd,
    stdout: (text) => { output += text; },
    stderr: (text) => { output += text; },
  }, runner);
  return { code, output };
}

describe("evaluation tasks and CLI", () => {
  test("ships three stack-specific fixtures and a host-default preset", () => {
    expect(listEvalTaskNames()).toEqual(["go-slug", "python-slug", "ts-slug"]);
    expect(loadEvalTask("ts-slug").criteria.map((criterion) => criterion.type)).toEqual([
      "file_exists",
      "regex",
      "stack_command",
    ]);
    expect(loadEvalModelPreset("host-default")).toMatchObject({ name: "host-default", models: {} });
  });

  test("fixture command criteria resolve from each fixture's Stack Profile without shell operators", () => {
    for (const name of listEvalTaskNames()) {
      const task = loadEvalTask(name);
      const profile = new StackService({
        rootDir: path.join(tempProject(), ".team"),
        projectDir: task.fixtureDirectory,
        config: { detect: true },
      }).resolveForProject().profile;
      expect(profile?.components.some((component) => Boolean(component.commands.test))).toBe(true);
      expect(task.criteria.some((criterion) => criterion.type === "stack_command" && criterion.key === "test"))
        .toBe(true);
    }
    expect(tokenizeStackCommand("go test ./...")).toEqual({ ok: true, value: ["go", "test", "./..."] });
    expect(tokenizeStackCommand("bun test && rm -rf .").ok).toBe(false);
  });

  test("prepares an isolated OpenCode project with the selected preset options", () => {
    const fixtureDirectory = tempProject();
    const dataRoot = path.join(fixtureDirectory, "data", ".team");
    const packageRoot = path.join(fixtureDirectory, "plugin-source");
    const preset = loadEvalModelPreset("host-default");
    prepareOpenCodeProject({
      taskName: "ts-slug",
      fixtureDirectory,
      dataRoot,
      taskText: "Do the task.",
      packageRoot,
      modelPreset: preset,
    });

    const pluginLoader = readFileSync(
      path.join(fixtureDirectory, ".opencode", "plugins", "delivery-team", "index.ts"),
      "utf8",
    );
    expect(pluginLoader).toContain(path.join(packageRoot, "src", "index.ts"));
    expect(JSON.parse(readFileSync(path.join(fixtureDirectory, "opencode.json"), "utf8"))).toMatchObject({
      plugins: [{
        package: "delivery-team",
        options: { root: dataRoot, models: {} },
      }],
    });
  });

  test("runs the fixture pipeline with a fake headless runner and persists reproducible results", async () => {
    const projectDir = tempProject();
    const rootDir = path.join(projectDir, ".team");
    const result = await cli(projectDir, [
      "eval", "run", "ts-slug", "--models", "host-default", "--root", rootDir,
    ], new StubRunner());
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.output);
    expect(payload).toMatchObject({
      ok: true,
      model_preset: "host-default",
      count: 1,
      evaluations: [{
        task: "ts-slug",
        status: "passed",
        score: 100,
        run_id: "eval-stub-run",
      }],
    });
    expect(payload.evaluations[0].prompt_set_sha).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.evaluations[0].model_set_sha).toMatch(/^[a-f0-9]{64}$/);

    const { db } = await openDatabase(path.join(rootDir, "team.db"));
    try {
      const rows = new EvalRepository(db).list();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ task: "ts-slug", score: 100 });
      expect(JSON.parse(rows[0]?.details_json ?? "{}")).toMatchObject({
        run: { loops: 1, cost: 0.25 },
        runner: { exit_code: 0, timed_out: false },
      });

      new EvalRepository(db).insert({
        task: "go-slug",
        promptSetSha: "prompt-sha-b",
        modelSetSha: "model-sha-b",
        score: 50,
        detailsJson: JSON.stringify({ status: "criteria_failed", run: { loops: 2, cost: 0.5 } }),
      });
    } finally {
      db.close();
    }

    const report = await cli(projectDir, [
      "eval", "report", "--by", "model_set_sha", "--root", rootDir,
    ]);
    expect(report.code).toBe(0);
    const reportPayload = JSON.parse(report.output);
    expect(reportPayload).toMatchObject({ ok: true, count: 2, by: "model_set_sha" });
    expect(reportPayload.groups.find((group: any) => group.key === "model-sha-b"))
      .toMatchObject({ count: 1, mean_score: 50, mean_loops: 2, mean_cost: 0.5 });
  });

  test("aggregates results by prompt and model hashes", () => {
    const rows: EvalRunRow[] = [
      {
        id: 1,
        task: "ts-slug",
        prompt_set_sha: "prompt-a",
        model_set_sha: "model-a",
        stack: "typescript",
        started_at: "2026-01-01T00:00:00.000Z",
        score: 100,
        details_json: JSON.stringify({ status: "passed", run: { loops: 1, cost: 0.1 } }),
      },
      {
        id: 2,
        task: "go-slug",
        prompt_set_sha: "prompt-a",
        model_set_sha: "model-b",
        stack: "go",
        started_at: "2026-01-02T00:00:00.000Z",
        score: 80,
        details_json: JSON.stringify({ status: "criteria_failed", run: { loops: 3, cost: 0.3 } }),
      },
    ];
    expect(buildEvalReport(rows, "prompt_set_sha")).toMatchObject([{
      key: "prompt-a",
      count: 2,
      mean_score: 90,
      mean_loops: 2,
      mean_cost: 0.2,
      model_set_shas: ["model-a", "model-b"],
    }]);
    expect(buildEvalReport(rows, "both")).toHaveLength(2);
  });
});
