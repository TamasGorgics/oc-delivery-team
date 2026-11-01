import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson, capturePromptSet, modelSetSha } from "./snapshot";
import { evaluateCriteria } from "./criteria";
import type { EvalRepository } from "../state/evals";
import { openDatabase } from "../state/db";
import { PromptRepository } from "../state/prompts";
import { RunRepository, parseJsonRecord } from "../state/runs";
import { StackService } from "../stack/service";
import type { PromptRepository as PromptRepositoryType } from "../state/prompts";
import type { StackProfile } from "../stack/profile";
import type { EvalModelPreset, EvalTask, CriterionResult } from "./types";
import type { EvalRunner } from "./runner";

export interface EvalTaskResult {
  readonly id: number;
  readonly task: string;
  readonly status: string;
  readonly score: number;
  readonly prompt_set_sha: string;
  readonly model_set_sha: string | null;
  readonly run_id: string | null;
  readonly criteria: readonly CriterionResult[];
}

export interface EvalExecutionOptions {
  readonly rootDir: string;
  readonly promptRepository: PromptRepositoryType;
  readonly evalRepository: EvalRepository;
  readonly tasks: readonly EvalTask[];
  readonly modelPreset?: EvalModelPreset;
  readonly runner: EvalRunner;
  readonly packageRoot: string;
}

export async function executeEvalTasks(options: EvalExecutionOptions): Promise<EvalTaskResult[]> {
  const promptSet = capturePromptSet(options.rootDir, options.promptRepository);
  const results: EvalTaskResult[] = [];
  for (const task of options.tasks) {
    results.push(await executeOneEval(options, task, promptSet));
  }
  return results;
}

async function executeOneEval(
  options: EvalExecutionOptions,
  task: EvalTask,
  promptSet: ReturnType<typeof capturePromptSet>,
): Promise<EvalTaskResult> {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-eval-"));
  try {
    return await executeEvalInWorkspace(options, task, promptSet, temporaryDirectory);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function executeEvalInWorkspace(
  options: EvalExecutionOptions,
  task: EvalTask,
  promptSet: ReturnType<typeof capturePromptSet>,
  temporaryDirectory: string,
): Promise<EvalTaskResult> {
  const fixtureDirectory = path.join(temporaryDirectory, "project");
  const dataRoot = path.join(temporaryDirectory, "data", ".team");
  copyFixture(task.fixtureDirectory, fixtureDirectory);
  mkdirSync(dataRoot, { recursive: true });
  await seedApprovedPrompts(dataRoot, promptSet.prompts);
  const startedAt = new Date().toISOString();

  let runnerResult: Awaited<ReturnType<EvalRunner["run"]>> = {
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    error: "Runner did not start.",
  };
  let runSummary: RunSummary | undefined;
  let modelSnapshot: unknown;
  let stackProfile: StackProfile | undefined;
  try {
    runnerResult = await options.runner.run({
      taskName: task.name,
      fixtureDirectory,
      dataRoot,
      taskText: task.taskText,
      packageRoot: options.packageRoot,
      ...(options.modelPreset ? { modelPreset: options.modelPreset } : {}),
    });
  } catch (error) {
    runnerResult = {
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      error: errorMessage(error),
    };
  }

  try {
    const { db } = await openDatabase(path.join(dataRoot, "team.db"));
    try {
      const runs = new RunRepository(db);
      const run = runs.listRuns().find((candidate) => path.resolve(candidate.project_dir) === path.resolve(fixtureDirectory));
      if (run) {
        const totals = runs.messageTotals(run.id);
        runSummary = {
          run_id: run.id,
          run_status: run.status,
          run_phase: run.phase,
          loops: runs.getLoops(run.id).reduce((sum, loop) => sum + loop.count, 0),
          messages: totals.messages,
          cost: totals.messages > 0 ? totals.cost : null,
          tokens_in: totals.tokens_in,
          tokens_out: totals.tokens_out,
        };
        const stackService = new StackService({
          rootDir: dataRoot,
          projectDir: fixtureDirectory,
          config: { detect: true },
          runs,
        });
        stackProfile = stackService.resolveForRun(run, false).profile;
      } else {
        stackProfile = new StackService({
          rootDir: dataRoot,
          projectDir: fixtureDirectory,
          config: { detect: true },
        }).resolveForProject().profile;
      }
      const snapshotRow = db.get<{ data_json: string }>(
        "SELECT data_json FROM events WHERE kind = 'models.snapshot' ORDER BY id DESC LIMIT 1",
      );
      modelSnapshot = snapshotRow ? parseJsonRecord(snapshotRow.data_json).roles : undefined;
    } finally {
      db.close();
    }
  } catch (error) {
    runnerResult = {
      ...runnerResult,
      error: runnerResult.error ?? `Could not read eval run data: ${errorMessage(error)}`,
    };
  }

  const criteria = evaluateCriteria(task.criteria, fixtureDirectory, stackProfile);
  const score = calculateScore(criteria);
  const status = runnerResult.error
    ? "runner_error"
    : runnerResult.exitCode !== 0
      ? "runner_failed"
      : !runSummary
        ? "no_run"
        : runSummary.run_status !== "closed" || runSummary.run_phase !== "done"
          ? "incomplete_run"
          : score === 100
            ? "passed"
            : "criteria_failed";
  const actualModelSet = modelSnapshot === undefined ? undefined : {
    host_model: options.modelPreset?.hostModel ?? null,
    preset_models: options.modelPreset?.models ?? null,
    resolved_roles: modelSnapshot,
  };
  const effectiveModelSha = actualModelSet ? modelSetSha(actualModelSet) : null;
  const stackSummary = stackProfile
    ? stackProfile.components.map((component) => ({
        name: component.name,
        root: component.root,
        languages: component.languages,
      }))
    : [];
  const details = {
    version: 1,
    status,
    run: runSummary ?? null,
    runner: {
      exit_code: runnerResult.exitCode,
      timed_out: runnerResult.timedOut,
      duration_ms: runnerResult.durationMs,
      ...(runnerResult.error ? { error: runnerResult.error } : {}),
    },
    criteria,
    score,
    prompt_set_sha: promptSet.sha,
    model_set_sha: effectiveModelSha,
    model_set: actualModelSet ?? null,
    stack: stackSummary,
  };
  const row = options.evalRepository.insert({
    task: task.name,
    promptSetSha: promptSet.sha,
    modelSetSha: effectiveModelSha,
    stack: canonicalJson(stackSummary),
    startedAt,
    score,
    detailsJson: JSON.stringify(details),
  });
  return {
    id: row.id,
    task: row.task,
    status,
    score,
    prompt_set_sha: promptSet.sha,
    model_set_sha: effectiveModelSha,
    run_id: runSummary?.run_id ?? null,
    criteria,
  };
}

interface RunSummary {
  readonly run_id: string;
  readonly run_status: string;
  readonly run_phase: string;
  readonly loops: number;
  readonly messages: number;
  readonly cost: number | null;
  readonly tokens_in: number;
  readonly tokens_out: number;
}

async function seedApprovedPrompts(
  dataRoot: string,
  prompts: ReturnType<typeof capturePromptSet>["prompts"],
): Promise<void> {
  const approved = prompts.filter((prompt) => prompt.source === "approved" && prompt.raw && prompt.sha);
  if (approved.length === 0) return;
  const promptDirectory = path.join(dataRoot, "prompts");
  mkdirSync(promptDirectory, { recursive: true });
  const { db } = await openDatabase(path.join(dataRoot, "team.db"));
  try {
    const repository = new PromptRepository(db);
    for (const prompt of approved) {
      writeFileSync(path.join(promptDirectory, `${prompt.role}.md`), prompt.raw as string, "utf8");
      const version = repository.recordProposal({
        role: prompt.role,
        sha: prompt.sha as string,
        path: `proposals/${prompt.role}.eval.md`,
      }).row;
      repository.setStatus(version.id, "approved");
    }
  } finally {
    db.close();
  }
}

function copyFixture(source: string, destination: string): void {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Eval fixture must be a regular directory: ${source}`);
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === ".team") continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Eval fixture contains a symlink: ${sourcePath}`);
    if (entry.isDirectory()) copyFixture(sourcePath, destinationPath);
    else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
  }
}

function calculateScore(criteria: readonly CriterionResult[]): number {
  const totalWeight = criteria.reduce((sum, result) => sum + result.weight, 0);
  if (totalWeight <= 0) return 0;
  const passedWeight = criteria.reduce((sum, result) => sum + (result.passed ? result.weight : 0), 0);
  return Math.round((passedWeight / totalWeight) * 10_000) / 100;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
