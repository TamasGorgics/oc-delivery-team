#!/usr/bin/env bun
import path from "node:path";
import {
  parseJsonRecord,
  RunRepository,
  type EventRow,
  type RunRow,
  type ToolCallRow,
} from "../state/runs";
import { openDatabase } from "../state/db";
import { resolveMainRepoDirectory } from "../state/paths";
import { redactSecrets, redactText } from "../state/privacy";
import { renderRunReport } from "../state/report";
import { StackService } from "../stack/service";

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

Options:
  --root <dir>  Data root (default: <main repo>/.team)
  --db <file>   Database file (default: <root>/team.db)
  --open        Only include open runs (team runs)
  --jsonl       Emit line-delimited trace records (team trace)
  --help        Show this help
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
    throw new CliUsageError(`Unknown command: ${command}`);
  } catch (error) {
    return fail(
      io,
      errorMessage(error),
      error instanceof CliUsageError ? "usage" : "cli_error",
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
    writeJson(io, {
      ok: true,
      database: paths.dbPath,
      open_only: args.open,
      count: rows.length,
      runs: rows.map((run) => runSummary(run, now)),
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
    if (arg.startsWith("-")) throw new CliUsageError(`Unknown option: ${arg}`);
    positionals.push(arg);
  }

  return {
    positionals,
    ...(root ? { root } : {}),
    ...(db ? { db } : {}),
    ...(run ? { run } : {}),
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

if (import.meta.main) {
  const exitCode = await runTeamCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
