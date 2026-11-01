#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROLE_IDS, isRoleId, type RoleId } from "../roles";
import {
  parseJsonRecord,
  RunRepository,
  type EventRow,
  type RunRow,
  type ToolCallRow,
} from "../state/runs";
import { openDatabase } from "../state/db";
import {
  LESSON_STATUSES,
  LessonsRepository,
  isLessonStatus,
  type LessonStatus,
} from "../state/lessons";
import { ensureDirectory, resolveMainRepoDirectory } from "../state/paths";
import { PromptRepository, type PromptVersionRow } from "../state/prompts";
import { redactSecrets, redactText } from "../state/privacy";
import { renderRunReport } from "../state/report";
import { listTeamWorktrees } from "../state/worktrees";
import { StackService } from "../stack/service";
import { getDefaultPrompt } from "../prompts";
import { promptProposalSha, scanPromptProposals } from "../prompts/proposals";
import { promptProposalPathFromArgument, renderPromptDiff } from "./prompts";
import {
  LESSON_EXPORT_DIRNAME,
  STALE_MIN_HIT_COUNT,
  findStaleLessons,
  lessonExportStem,
  renderLessonExport,
} from "./lessons";

export interface CliIO {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface ParsedArgs {
  readonly positionals: string[];
  readonly root?: string;
  readonly db?: string;
  readonly run?: string;
  readonly status?: string;
  readonly open: boolean;
  readonly jsonl: boolean;
  readonly help: boolean;
}

const USAGE = `Usage: team [--root <dir>] [--db <file>] <command>

Commands:
  team db migrate                  Apply pending database migrations
  team stack [<run>] [--run <id>]  Show the resolved Stack Profile and provenance
  team models [--run <id>]         Show the live model snapshot or a run's stored models
  team runs [--open]               List runs as JSON
  team report <run>                Render a run report as Markdown
  team trace <run> [--jsonl]       Show tool calls and events as JSON or JSONL
  team lessons [--status <status>] List lessons
  team lessons approve|reject|retire <id>
                                   Change a lesson's status and decided_at
  team lessons export              Write approved lessons to <root>/lessons-export
  team lessons stale               Report high-hit approved lessons without evidence
  team prompts list                List proposed and decided prompt versions
  team prompts approve <file>      Approve a proposal and require an OpenCode restart
  team prompts reject <file>       Reject a proposal
  team prompts diff <file>         Compare a proposal with the current prompt

Options:
  --root <dir>     Data root (default: <main repo>/.team)
  --db <file>      Database file (default: <root>/team.db)
  --status <name>  Filter lessons by proposed, approved, retired, or rejected
  --open           Only include open runs (team runs)
  --jsonl          Emit line-delimited trace records (team trace)
  --help           Show this help
`;

export async function runTeamCli(
  argv: readonly string[],
  overrides: Partial<CliIO> = {},
): Promise<number> {
  const io: CliIO = {
    cwd: overrides.cwd ?? process.cwd(),
    stdout: overrides.stdout ?? ((text) => process.stdout.write(text)),
    stderr: overrides.stderr ?? ((text) => process.stderr.write(text)),
  };

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return fail(io, errorMessage(error), "usage", 2);
  }

  if (parsed.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (parsed.positionals.length === 0) {
    io.stderr(USAGE);
    return 2;
  }

  const [command, ...rest] = parsed.positionals;
  try {
    if (command === "db") {
      if (rest.length !== 1 || rest[0] !== "migrate") {
        throw new CliUsageError("db currently supports only: team db migrate");
      }
      return await runMigrate(io, parsed);
    }
    if (command === "stack") {
      if (rest.length > 1) throw new CliUsageError("team stack accepts at most one run id.");
      const runId = parsed.run ?? rest[0];
      if (parsed.run && rest[0] && parsed.run !== rest[0]) {
        throw new CliUsageError("Pass the run id either as an argument or with --run, not both.");
      }
      return await runStack(io, parsed, runId);
    }
    if (command === "models") {
      if (rest.length > 0) throw new CliUsageError("team models accepts only the --run flag.");
      return await runModels(io, parsed);
    }
    if (command === "runs") {
      if (rest.length > 0) throw new CliUsageError("team runs accepts only the --open flag.");
      return await runRuns(io, parsed);
    }
    if (command === "report") {
      const runId = commandRunId(rest, parsed, "team report <run>");
      return await runReport(io, parsed, runId);
    }
    if (command === "trace") {
      const runId = commandRunId(rest, parsed, "team trace <run> [--jsonl]");
      return await runTrace(io, parsed, runId);
    }
    if (command === "lessons") {
      return await runLessons(io, parsed, rest);
    }
    if (command === "prompts") {
      return await runPrompts(io, parsed, rest);
    }
    throw new CliUsageError(`Unknown command: ${command}`);
  } catch (error) {
    return fail(
      io,
      errorMessage(error),
      error instanceof CliUsageError
        ? "usage"
        : error instanceof CliCommandError
          ? error.code
          : "cli_error",
      error instanceof CliUsageError ? 2 : 1,
    );
  }
}

async function runMigrate(io: CliIO, args: ParsedArgs): Promise<number> {
  const paths = resolvePaths(io, args);
  const { db, migration } = await openDatabase(paths.dbPath);
  try {
    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      driver: db.driver,
      from_version: migration.fromVersion,
      to_version: migration.toVersion,
      applied: migration.applied,
    });
    return 0;
  } finally {
    db.close();
  }
}

async function runStack(io: CliIO, args: ParsedArgs, runId: string | undefined): Promise<number> {
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const runs = new RunRepository(db);
    const run = runId ? requireRun(runs, runId) : undefined;
    const service = new StackService({
      rootDir: paths.rootDir,
      projectDir: paths.projectDir,
      config: { detect: true },
      runs,
    });
    const resolution = run ? service.resolveForRun(run, false) : service.resolveForProject();
    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      run: run?.id ?? null,
      phase: run?.phase ?? null,
      layer: resolution.layer,
      sources: resolution.sources.map(sourceLabel),
      provenance: provenance(paths.rootDir, resolution.sources, run),
      globs_defaulted: resolution.globsDefaulted,
      diagnostics: resolution.diagnostics,
      profile: resolution.profile,
    });
    return 0;
  } finally {
    db.close();
  }
}

async function runModels(io: CliIO, args: ParsedArgs): Promise<number> {
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const runs = new RunRepository(db);
    if (args.run) {
      const run = requireRun(runs, args.run);
      const roles = runs.listRunModels(run.id);
      const warnings = runs
        .listRecentEvents(run.id, 200)
        .filter((event) => event.kind.startsWith("model."))
        .map((event) => ({
          kind: event.kind,
          at: event.at,
          data: parseJsonRecord(event.data_json),
        }));
      writeJson(io, {
        ok: true,
        database: paths.dbPath,
        source: "run",
        run: run.id,
        phase: run.phase,
        roles,
        warnings,
      });
      return 0;
    }

    const snapshot = runs.latestEvent("models.snapshot");
    if (!snapshot) {
      throw new Error(
        "No model snapshot was found. Start OpenCode with the delivery-team plugin once, or use team models --run <id>.",
      );
    }
    const data = parseJsonRecord(snapshot.data_json);
    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      source: "snapshot",
      at: snapshot.at,
      roles: data.roles ?? {},
      events: data.events ?? [],
    });
    return 0;
  } finally {
    db.close();
  }
}

async function runRuns(io: CliIO, args: ParsedArgs): Promise<number> {
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const runs = new RunRepository(db);
    const rows = runs.listRuns(args.open);
    const now = Date.now();
    const worktreeList = listTeamWorktrees(paths.projectDir);
    const worktrees = worktreeList.worktrees.map((worktree) => {
      const run = runs.getRun(worktree.run);
      return {
        ...worktree,
        run_status: run?.status ?? null,
        run_phase: run?.phase ?? null,
      };
    });
    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      open_only: args.open,
      count: rows.length,
      runs: rows.map((run) => runSummary(run, now)),
      worktree_status: worktreeList.available ? "available" : "unavailable",
      worktree_count: worktrees.length,
      worktrees,
      ...(worktreeList.error ? { worktree_warning: worktreeList.error } : {}),
    });
    return 0;
  } finally {
    db.close();
  }
}

async function runReport(io: CliIO, args: ParsedArgs, runId: string): Promise<number> {
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const runs = new RunRepository(db);
    const run = requireRun(runs, runId);
    io.stdout(renderRunReport({
      run,
      transitions: runs.getTransitions(run.id),
      loops: runs.getLoops(run.id),
      notes: runs.listNotes(run.id),
      events: runs.listEvents(run.id),
      toolCalls: runs.listToolCalls(run.id),
      messages: runs.listMessages(run.id),
      sessions: runs.listSessionsForRun(run.id),
    }));
    return 0;
  } finally {
    db.close();
  }
}

async function runTrace(io: CliIO, args: ParsedArgs, runId: string): Promise<number> {
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const runs = new RunRepository(db);
    const run = requireRun(runs, runId);
    const events = runs.listEvents(run.id);
    const toolCalls = runs.listToolCalls(run.id);

    if (args.jsonl) {
      const records = [
        ...events.map(traceEventRecord),
        ...toolCalls.map(traceToolCallRecord),
      ].sort(compareTraceRecords);
      for (const record of records) io.stdout(`${JSON.stringify(record)}\n`);
      return 0;
    }

    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      run: run.id,
      events: events.map((event) => ({
        ...traceEventRecord(event),
        id: event.id,
      })),
      tool_calls: toolCalls.map((row) => ({
        ...traceToolCallRecord(row),
        id: row.id,
      })),
    });
    return 0;
  } finally {
    db.close();
  }
}

async function runLessons(
  io: CliIO,
  args: ParsedArgs,
  rest: readonly string[],
): Promise<number> {
  const action = rest[0];

  if (action === undefined || action === "list") {
    if (rest.length > 1) {
      throw new CliUsageError("Usage: team lessons [--status <status>]");
    }
    return await runLessonList(io, args);
  }

  if (action === "approve" || action === "reject" || action === "retire") {
    if (rest.length !== 2) {
      throw new CliUsageError(`Usage: team lessons ${action} <id>`);
    }
    if (args.status !== undefined) {
      throw new CliUsageError("--status applies only when listing lessons.");
    }
    return await runLessonStatus(io, args, action, parseLessonId(rest[1]));
  }

  if (action === "export" || action === "stale") {
    if (rest.length !== 1) {
      throw new CliUsageError(`Usage: team lessons ${action}`);
    }
    if (args.status !== undefined) {
      throw new CliUsageError("--status applies only when listing lessons.");
    }
    return action === "export"
      ? await runLessonExport(io, args)
      : await runLessonStale(io, args);
  }

  throw new CliUsageError(
    "Usage: team lessons [--status <status>] | approve|reject|retire <id> | export | stale",
  );
}

async function runLessonList(io: CliIO, args: ParsedArgs): Promise<number> {
  const status = lessonStatusFilter(args);
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const lessons = new LessonsRepository(db).list(status ? { status } : {});
    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      status: status ?? null,
      count: lessons.length,
      lessons,
    });
    return 0;
  } finally {
    db.close();
  }
}

async function runLessonStatus(
  io: CliIO,
  args: ParsedArgs,
  action: "approve" | "reject" | "retire",
  id: number,
): Promise<number> {
  const target: LessonStatus = action === "approve"
    ? "approved"
    : action === "reject"
      ? "rejected"
      : "retired";
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const lessons = new LessonsRepository(db);
    const existing = lessons.get(id);
    if (!existing) {
      throw new CliCommandError(`Lesson ${id} was not found.`, "lesson_not_found");
    }
    if (action === "retire" && existing.status !== "approved" && existing.status !== "retired") {
      throw new CliCommandError(
        `Only approved lessons can be retired; lesson ${id} is ${existing.status}.`,
        "invalid_transition",
      );
    }

    const changed = existing.status !== target;
    const lesson = changed ? lessons.setStatus(id, target) : existing;
    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      action,
      previous_status: existing.status,
      changed,
      lesson,
    });
    return 0;
  } finally {
    db.close();
  }
}

async function runLessonExport(io: CliIO, args: ParsedArgs): Promise<number> {
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const approved = new LessonsRepository(db).list({ status: "approved" });
    const byRole = new Map<string, typeof approved>();
    for (const lesson of approved) {
      const group = byRole.get(lesson.role);
      if (group) group.push(lesson);
      else byRole.set(lesson.role, [lesson]);
    }

    const groups = [...byRole.entries()].sort(([left], [right]) => compareLessonRoles(left, right));
    const directory = path.join(paths.rootDir, LESSON_EXPORT_DIRNAME);
    ensureDirectory(directory);

    const desired = new Set<string>();
    const files = groups.map(([role, lessons]) => {
      const file = path.join(directory, `${lessonExportStem(role)}.md`);
      writeFileSync(file, renderLessonExport(role, lessons), "utf8");
      desired.add(path.basename(file));
      return { role, path: file, count: lessons.length };
    });

    const knownFiles = new Set([
      ...ROLE_IDS.map((role) => `${lessonExportStem(role)}.md`),
      `${lessonExportStem("*")}.md`,
    ]);
    const removed: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (!knownFiles.has(entry.name) || desired.has(entry.name)) continue;
      unlinkSync(path.join(directory, entry.name));
      removed.push(entry.name);
    }
    removed.sort();

    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      directory,
      count: approved.length,
      roles: groups.map(([role]) => role),
      files,
      removed,
    });
    return 0;
  } finally {
    db.close();
  }
}

async function runLessonStale(io: CliIO, args: ParsedArgs): Promise<number> {
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const approved = new LessonsRepository(db).list({ status: "approved" });
    const stale = findStaleLessons(approved);
    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      report_only: true,
      criteria: {
        status: "approved",
        min_hit_count: STALE_MIN_HIT_COUNT,
        evidence: "missing",
      },
      count: stale.length,
      lessons: stale,
    });
    return 0;
  } finally {
    db.close();
  }
}

function lessonStatusFilter(args: ParsedArgs): LessonStatus | undefined {
  if (args.status === undefined) return undefined;
  if (!isLessonStatus(args.status)) {
    throw new CliUsageError(`--status must be one of ${LESSON_STATUSES.join(", ")}.`);
  }
  return args.status;
}

function parseLessonId(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new CliUsageError("Lesson id must be a positive integer.");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new CliUsageError("Lesson id must be a positive integer.");
  }
  return id;
}

function compareLessonRoles(left: string, right: string): number {
  if (left === right) return 0;
  if (left === "*") return -1;
  if (right === "*") return 1;
  return left.localeCompare(right);
}

async function runPrompts(
  io: CliIO,
  args: ParsedArgs,
  rest: readonly string[],
): Promise<number> {
  if (args.status !== undefined) {
    throw new CliUsageError("--status is not supported by team prompts.");
  }
  const action = rest[0];
  if (action === undefined || action === "list") {
    if (rest.length > 1) throw new CliUsageError("Usage: team prompts list");
    return await runPromptList(io, args);
  }
  if (action === "approve" || action === "reject" || action === "diff") {
    if (rest.length !== 2) {
      throw new CliUsageError(`Usage: team prompts ${action} <role.timestamp[.md]>`);
    }
    const sourcePath = promptProposalPathFromArgument(rest[1]);
    if (!sourcePath) {
      throw new CliUsageError("Prompt proposal must be a role.timestamp filename, optionally prefixed by proposals/.");
    }
    if (action === "diff") return await runPromptDiff(io, args, sourcePath);
    return await runPromptDecision(io, args, action, sourcePath);
  }
  throw new CliUsageError("Usage: team prompts list | approve|reject|diff <role.timestamp[.md]>");
}

async function runPromptList(io: CliIO, args: ParsedArgs): Promise<number> {
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const prompts = new PromptRepository(db);
    scanPromptProposals(paths.rootDir, prompts);
    const versions = prompts.list();
    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      count: versions.length,
      prompts: versions.map((version) => ({
        ...version,
        file: version.path ? path.posix.basename(version.path) : null,
        current_path: version.status === "approved"
          ? path.join(paths.rootDir, "prompts", `${version.role}.md`)
          : null,
      })),
    });
    return 0;
  } finally {
    db.close();
  }
}

async function runPromptDiff(
  io: CliIO,
  args: ParsedArgs,
  sourcePath: string,
): Promise<number> {
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const prompts = new PromptRepository(db);
    scanPromptProposals(paths.rootDir, prompts);
    const version = prompts.getByPath(sourcePath);
    if (!version) throw new CliCommandError("Prompt proposal was not found.", "prompt_not_found");
    if (!isRoleId(version.role)) {
      throw new CliCommandError("Prompt proposal has an invalid role.", "invalid_proposal");
    }
    const proposalFile = promptProposalAbsolutePath(paths.rootDir, version.path);
    const proposalText = readRegularPromptFile(proposalFile);
    const current = readCurrentPrompt(paths.rootDir, version.role);
    io.stdout(renderPromptDiff(
      current.text,
      proposalText,
      current.label,
      `proposal:${path.posix.basename(sourcePath)}`,
    ));
    return 0;
  } finally {
    db.close();
  }
}

async function runPromptDecision(
  io: CliIO,
  args: ParsedArgs,
  action: "approve" | "reject",
  sourcePath: string,
): Promise<number> {
  const paths = resolvePaths(io, args);
  const { db } = await openDatabase(paths.dbPath);
  try {
    const prompts = new PromptRepository(db);
    scanPromptProposals(paths.rootDir, prompts);
    const existing = prompts.getByPath(sourcePath);
    if (!existing) throw new CliCommandError("Prompt proposal was not found.", "prompt_not_found");

    if (action === "reject") {
      if (existing.status === "rejected") {
        writeJson(io, {
          ok: true,
          database: paths.dbPath,
          action,
          previous_status: existing.status,
          changed: false,
          prompt: existing,
        });
        return 0;
      }
      if (existing.status !== "proposed") {
        throw new CliCommandError(
          `Only proposed prompts can be rejected; prompt ${existing.id} is ${existing.status}.`,
          "invalid_transition",
        );
      }
      const decidedAt = new Date().toISOString();
      const prompt = prompts.setStatusFrom(existing.id, "proposed", "rejected", decidedAt);
      if (!prompt) {
        const latest = prompts.get(existing.id);
        if (latest?.status === "rejected") {
          writeJson(io, {
            ok: true,
            database: paths.dbPath,
            action,
            previous_status: existing.status,
            changed: false,
            prompt: latest,
          });
          return 0;
        }
        throw new CliCommandError("Prompt status changed before the rejection was recorded.", "invalid_transition");
      }
      writeJson(io, {
        ok: true,
        database: paths.dbPath,
        action,
        previous_status: existing.status,
        changed: true,
        prompt,
      });
      return 0;
    }

    if (existing.status === "approved") {
      writeJson(io, {
        ok: true,
        database: paths.dbPath,
        action,
        previous_status: existing.status,
        changed: false,
        current_path: path.join(paths.rootDir, "prompts", `${existing.role}.md`),
        restart_required: true,
        prompt: existing,
      });
      return 0;
    }
    if (existing.status !== "proposed") {
      throw new CliCommandError(
        `Only proposed prompts can be approved; prompt ${existing.id} is ${existing.status}.`,
        "invalid_transition",
      );
    }
    if (!isRoleId(existing.role)) {
      throw new CliCommandError("Prompt proposal has an invalid role.", "invalid_proposal");
    }

    const proposalFile = promptProposalAbsolutePath(paths.rootDir, existing.path);
    const proposalText = readRegularPromptFile(proposalFile);
    if (proposalText.trim().length === 0) {
      throw new CliCommandError("Prompt proposal must not be empty.", "invalid_proposal");
    }
    const decidedAt = new Date().toISOString();
    const result = approvePromptFile(
      paths.rootDir,
      proposalFile,
      existing,
      proposalText,
      prompts,
      db,
      decidedAt,
    );
    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      action,
      previous_status: existing.status,
      changed: true,
      prompt: result.prompt,
      current_path: result.currentPath,
      restart_required: true,
      ...(result.cleanup_warning ? { warning: result.cleanup_warning } : {}),
    });
    return 0;
  } finally {
    db.close();
  }
}

function approvePromptFile(
  rootDir: string,
  proposalFile: string,
  version: PromptVersionRow,
  proposalText: string,
  repository: PromptRepository,
  db: Awaited<ReturnType<typeof openDatabase>>["db"],
  decidedAt: string,
): { readonly prompt: PromptVersionRow; readonly currentPath: string; readonly cleanup_warning?: string } {
  if (!isRoleId(version.role)) throw new CliCommandError("Prompt proposal has an invalid role.", "invalid_proposal");
  const promptsDirectory = ensurePlainDirectory(rootDir, "prompts");
  const currentPath = path.join(promptsDirectory, `${version.role}.md`);
  const currentStat = lstatIfPresent(currentPath);
  if (currentStat && (!currentStat.isFile() || currentStat.isSymbolicLink())) {
    throw new CliCommandError("Current prompt path must be a regular file.", "unsafe_path");
  }

  const backupPath = currentStat
    ? path.join(promptsDirectory, `.${version.role}.${version.id}.${randomUUID()}.backup`)
    : undefined;
  if (backupPath) renameSync(currentPath, backupPath);

  try {
    renameSync(proposalFile, currentPath);
    try {
      db.transaction(() => {
        repository.updateProposedSha(version.id, promptProposalSha(proposalText));
        repository.supersedeApproved(version.role, decidedAt);
        const approved = repository.setStatusFrom(version.id, "proposed", "approved", decidedAt);
        if (!approved) throw new Error(`Prompt version ${version.id} disappeared during approval.`);
      });
    } catch (error) {
      try {
        renameSync(currentPath, proposalFile);
        if (backupPath) renameSync(backupPath, currentPath);
      } catch (rollbackError) {
        throw new Error(
          `Prompt approval failed (${errorMessage(error)}); file rollback also failed (${errorMessage(rollbackError)}).`,
        );
      }
      throw error;
    }

    const prompt = repository.get(version.id);
    if (!prompt) throw new Error(`Prompt version ${version.id} was approved but could not be read back.`);
    let cleanupWarning: string | undefined;
    if (backupPath) {
      try {
        unlinkSync(backupPath);
      } catch (error) {
        cleanupWarning = `Approved successfully but could not remove the previous prompt backup: ${errorMessage(error)}`;
      }
    }
    return {
      prompt,
      currentPath,
      ...(cleanupWarning ? { cleanup_warning: cleanupWarning } : {}),
    };
  } catch (error) {
    if (backupPath && lstatIfPresent(backupPath) && !lstatIfPresent(currentPath)) {
      renameSync(backupPath, currentPath);
    }
    throw error;
  }
}

function promptProposalAbsolutePath(rootDir: string, sourcePath: string | null): string {
  const relativePath = sourcePath ?? "";
  const normalized = promptProposalPathFromArgument(relativePath);
  if (!normalized || normalized !== relativePath) {
    throw new CliCommandError("Prompt proposal path is invalid.", "invalid_proposal");
  }
  return path.join(rootDir, "proposals", path.posix.basename(relativePath));
}

function readRegularPromptFile(filePath: string): string {
  const stat = lstatIfPresent(filePath);
  if (!stat) throw new CliCommandError("Prompt proposal file was not found.", "prompt_not_found");
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CliCommandError("Prompt proposal must be a regular file.", "unsafe_path");
  }
  return readFileSync(filePath, "utf8");
}

function readCurrentPrompt(rootDir: string, role: RoleId): { readonly text: string; readonly label: string } {
  const fallback = getDefaultPrompt(role);
  const promptsDirectory = path.join(rootDir, "prompts");
  const directoryStat = lstatIfPresent(promptsDirectory);
  if (!directoryStat) return { text: fallback, label: `built-in:${role}` };
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new CliCommandError("Prompt override path must be a regular directory.", "unsafe_path");
  }
  const currentPath = path.join(promptsDirectory, `${role}.md`);
  const currentStat = lstatIfPresent(currentPath);
  if (!currentStat) return { text: fallback, label: `built-in:${role}` };
  if (!currentStat.isFile() || currentStat.isSymbolicLink()) {
    throw new CliCommandError("Current prompt path must be a regular file.", "unsafe_path");
  }
  const text = readFileSync(currentPath, "utf8").trim();
  return text ? { text, label: `prompts/${role}.md` } : { text: fallback, label: `built-in:${role}` };
}

function ensurePlainDirectory(rootDir: string, name: "prompts"): string {
  const directory = path.join(rootDir, name);
  let stat = lstatIfPresent(directory);
  if (!stat) {
    ensureDirectory(directory);
    stat = lstatIfPresent(directory);
  }
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new CliCommandError(`Prompt ${name} path must be a regular directory.`, "unsafe_path");
  }
  return directory;
}

function lstatIfPresent(filePath: string) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function runSummary(run: RunRow, now: number): Record<string, unknown> {
  const created = Date.parse(run.created_at);
  const ageMs = Number.isFinite(created) ? Math.max(0, now - created) : null;
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    phase: run.phase,
    created_at: run.created_at,
    closed_at: run.closed_at,
    age_ms: ageMs,
    age: ageMs === null ? null : formatAge(ageMs),
    project_dir: run.project_dir,
  };
}

function traceEventRecord(event: EventRow): Record<string, unknown> {
  return {
    type: "event",
    at: event.at,
    run_id: event.run_id,
    kind: event.kind,
    data: redactSecrets(parseJsonRecord(event.data_json)),
  };
}

function traceToolCallRecord(row: ToolCallRow): Record<string, unknown> {
  const parsedInput = row.input_json ? redactSecrets(parseJsonValue(row.input_json)) : undefined;
  const preview = row.output_preview ? redactText(row.output_preview) : undefined;
  return {
    type: "tool_call",
    at: row.started_at,
    run_id: row.run_id,
    tool_call_id: row.tool_call_id,
    tool: row.tool,
    session_id: row.session_id,
    agent: row.agent,
    phase: row.phase,
    ok: row.ok === null ? null : row.ok === 1,
    duration_ms: row.duration_ms,
    output_bytes: row.output_bytes,
    ...(parsedInput !== undefined ? { input: parsedInput } : {}),
    ...(preview !== undefined ? { output_preview: preview } : {}),
  };
}

function compareTraceRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftAt = typeof left.at === "string" ? left.at : "";
  const rightAt = typeof right.at === "string" ? right.at : "";
  const byTime = leftAt.localeCompare(rightAt);
  if (byTime !== 0) return byTime;
  const leftType = String(left.type);
  const rightType = String(right.type);
  const byType = leftType.localeCompare(rightType);
  if (byType !== 0) return byType;
  return String(left.tool ?? left.kind ?? "").localeCompare(String(right.tool ?? right.kind ?? ""));
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / 86_400_000).toFixed(1)} d`;
}

function commandRunId(rest: readonly string[], args: ParsedArgs, usage: string): string {
  if (rest.length > 1) throw new CliUsageError(`Usage: ${usage}`);
  const runId = args.run ?? rest[0];
  if (args.run && rest[0] && args.run !== rest[0]) {
    throw new CliUsageError("Pass the run id either as an argument or with --run, not both.");
  }
  if (!runId) throw new CliUsageError(`Usage: ${usage}`);
  return runId;
}

function requireRun(runs: RunRepository, runId: string): RunRow {
  const run = runs.getRun(runId);
  if (!run) throw new Error(`Run ${runId} was not found.`);
  return run;
}

function sourceLabel(layer: string): string {
  return layer === "run" ? "researcher" : layer === "override" ? "override" : layer;
}

function provenance(
  rootDir: string,
  sources: readonly string[],
  run: RunRow | undefined,
): Array<{ layer: string; origin: string }> {
  return sources.map((layer) => {
    switch (layer) {
      case "human":
        return { layer, origin: path.join(rootDir, "stack.json") };
      case "override":
        return { layer, origin: "options.stack.overrides" };
      case "run":
        return {
          layer: "researcher",
          origin: run ? path.join(rootDir, "runs", run.id, "stack.json") : "runs.stack_json",
        };
      case "detected":
        return { layer, origin: "auto-detection" };
      default:
        return { layer, origin: "empty profile" };
    }
  });
}

function resolvePaths(io: CliIO, args: ParsedArgs): {
  readonly rootDir: string;
  readonly dbPath: string;
  readonly projectDir: string;
} {
  const rootDir = args.root
    ? path.isAbsolute(args.root)
      ? path.normalize(args.root)
      : path.resolve(io.cwd, args.root)
    : path.resolve(resolveMainRepoDirectory(io.cwd), ".team");
  const dbPath = args.db
    ? path.isAbsolute(args.db)
      ? path.normalize(args.db)
      : path.resolve(io.cwd, args.db)
    : path.join(rootDir, "team.db");
  return { rootDir, dbPath, projectDir: io.cwd };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  let root: string | undefined;
  let db: string | undefined;
  let run: string | undefined;
  let status: string | undefined;
  let open = false;
  let jsonl = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--open") {
      open = true;
      continue;
    }
    if (arg === "--jsonl") {
      jsonl = true;
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = requireValue("--root", arg.slice("--root=".length));
      continue;
    }
    if (arg === "--root") {
      root = requireValue(arg, argv[++index]);
      continue;
    }
    if (arg.startsWith("--db=")) {
      db = requireValue("--db", arg.slice("--db=".length));
      continue;
    }
    if (arg === "--db") {
      db = requireValue(arg, argv[++index]);
      continue;
    }
    if (arg.startsWith("--run=")) {
      run = requireValue("--run", arg.slice("--run=".length));
      continue;
    }
    if (arg === "--run") {
      run = requireValue(arg, argv[++index]);
      continue;
    }
    if (arg.startsWith("--status=")) {
      status = requireValue("--status", arg.slice("--status=".length));
      continue;
    }
    if (arg === "--status") {
      status = requireValue(arg, argv[++index]);
      continue;
    }
    if (arg.startsWith("-")) throw new CliUsageError(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  return {
    positionals,
    ...(root ? { root } : {}),
    ...(db ? { db } : {}),
    ...(run ? { run } : {}),
    ...(status ? { status } : {}),
    open,
    jsonl,
    help,
  };
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("-")) throw new CliUsageError(`${flag} requires a value.`);
  return value;
}

function writeJson(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(io: CliIO, message: string, code: string, exitCode: number): number {
  io.stderr(`${JSON.stringify({ ok: false, code, error: message }, null, 2)}\n`);
  return exitCode;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

class CliCommandError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CliCommandError";
  }
}

if (import.meta.main) {
  const exitCode = await runTeamCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
