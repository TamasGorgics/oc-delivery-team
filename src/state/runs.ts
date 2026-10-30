import type { ModelResolutionSource } from "../models";
import type { TeamDatabase } from "./db";
import type { Phase } from "./phases";
import { serializeTraceJson } from "./trace";

export type RunStatus = "open" | "blocked" | "closed" | "aborted";

export interface RunRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: RunStatus;
  readonly phase: Phase;
  readonly lead_session_id: string | null;
  readonly project_dir: string;
  readonly stack_json: string | null;
  readonly created_at: string;
  readonly closed_at: string | null;
}

export interface PhaseTransitionRow {
  readonly id: number;
  readonly run_id: string;
  readonly from_phase: Phase | null;
  readonly to_phase: Phase;
  readonly kind: "advance" | "rewind" | "start";
  readonly reason: string | null;
  readonly at: string;
}

export interface SessionRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly run_id: string | null;
  readonly agent: string | null;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

export interface LoopRow {
  readonly run_id: string;
  readonly phase: Phase;
  readonly count: number;
}

export interface NoteRow {
  readonly id: number;
  readonly run_id: string;
  readonly kind: string;
  readonly text: string;
  readonly agent: string | null;
  readonly session_id: string | null;
  readonly at: string;
}

export interface EventRow {
  readonly id: number;
  readonly run_id: string | null;
  readonly at: string;
  readonly kind: string;
  readonly data_json: string | null;
}

export interface RunModelInput {
  readonly role: string;
  readonly model: string | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly source: ModelResolutionSource;
}

export interface RunModelRow {
  readonly run_id: string;
  readonly role: string;
  readonly model: string | null;
  readonly params: Record<string, unknown>;
  readonly source: ModelResolutionSource;
}

export interface CreateRunInput {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly sessionId: string;
  readonly projectDir: string;
  readonly phase: Phase;
}

export class RunRepository {
  constructor(
    private readonly db: TeamDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  createRun(input: CreateRunInput): RunRow {
    this.db.run(
      `INSERT INTO runs (
        id, title, description, status, phase, lead_session_id, project_dir, stack_json, created_at, closed_at
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, NULL, ?, NULL)`,
      [
        input.id,
        input.title,
        input.description ?? null,
        input.phase,
        input.sessionId,
        input.projectDir,
        this.now(),
      ],
    );
    const run = this.getRun(input.id);
    if (!run) throw new Error(`Run ${input.id} was inserted but could not be read back.`);
    return run;
  }

  getRun(id: string): RunRow | undefined {
    return this.db.get<RunRow>("SELECT * FROM runs WHERE id = ?", [id]);
  }

  listOpenRuns(): RunRow[] {
    return this.db.all<RunRow>("SELECT * FROM runs WHERE status = 'open' ORDER BY created_at, id");
  }

  listRuns(openOnly = false): RunRow[] {
    if (openOnly) return this.listOpenRuns();
    return this.db.all<RunRow>("SELECT * FROM runs ORDER BY created_at DESC, id");
  }

  updatePhase(runId: string, phase: Phase): void {
    this.db.run("UPDATE runs SET phase = ? WHERE id = ?", [phase, runId]);
  }

  closeRun(runId: string, status: Extract<RunStatus, "closed" | "aborted"> = "closed"): void {
    this.db.run("UPDATE runs SET status = ?, closed_at = ? WHERE id = ?", [status, this.now(), runId]);
  }

  setStackJson(runId: string, stackJson: string | null): void {
    this.db.run("UPDATE runs SET stack_json = ? WHERE id = ?", [stackJson, runId]);
  }

  addTransition(input: {
    readonly runId: string;
    readonly from: Phase | null;
    readonly to: Phase;
    readonly kind: "advance" | "rewind" | "start";
    readonly reason?: string | null;
    readonly at?: string;
  }): number {
    const result = this.db.run(
      "INSERT INTO phase_transitions (run_id, from_phase, to_phase, kind, reason, at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        input.runId,
        input.from,
        input.to,
        input.kind,
        input.reason ?? null,
        input.at ?? this.now(),
      ],
    );
    return Number(result.lastInsertRowid);
  }

  getTransitions(runId: string): PhaseTransitionRow[] {
    return this.db.all<PhaseTransitionRow>(
      "SELECT * FROM phase_transitions WHERE run_id = ? ORDER BY id",
      [runId],
    );
  }

  getPhaseStartedAt(runId: string): string | undefined {
    return this.db.get<{ at: string }>(
      "SELECT at FROM phase_transitions WHERE run_id = ? ORDER BY id DESC LIMIT 1",
      [runId],
    )?.at;
  }

  getLoops(runId: string): LoopRow[] {
    return this.db.all<LoopRow>("SELECT * FROM loops WHERE run_id = ? ORDER BY phase", [runId]);
  }

  getLoop(runId: string, phase: Phase): number {
    const row = this.db.get<{ count: number }>(
      "SELECT count FROM loops WHERE run_id = ? AND phase = ?",
      [runId, phase],
    );
    return row ? Number(row.count) : 0;
  }

  incrementLoop(runId: string, phase: Phase): number {
    this.db.run(
      `INSERT INTO loops (run_id, phase, count) VALUES (?, ?, 1)
       ON CONFLICT(run_id, phase) DO UPDATE SET count = count + 1`,
      [runId, phase],
    );
    return this.getLoop(runId, phase);
  }

  addNote(input: {
    readonly runId: string;
    readonly kind: string;
    readonly text: string;
    readonly agent?: string | null;
    readonly sessionId?: string | null;
    readonly at?: string;
  }): number {
    const result = this.db.run(
      "INSERT INTO notes (run_id, kind, text, agent, session_id, at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        input.runId,
        input.kind,
        input.text,
        input.agent ?? null,
        input.sessionId ?? null,
        input.at ?? this.now(),
      ],
    );
    return Number(result.lastInsertRowid);
  }

  listNotes(runId: string): NoteRow[] {
    return this.db.all<NoteRow>("SELECT * FROM notes WHERE run_id = ? ORDER BY id", [runId]);
  }

  countOpenLessons(): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lessons WHERE status = 'proposed'",
    );
    return row ? Number(row.count) : 0;
  }

  listRecentEvents(runId: string, limit = 10): EventRow[] {
    return this.db.all<EventRow>(
      "SELECT * FROM events WHERE run_id = ? ORDER BY id DESC LIMIT ?",
      [runId, Math.max(1, limit)],
    );
  }

  latestEvent(kind: string): EventRow | undefined {
    return this.db.get<EventRow>(
      "SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1",
      [kind],
    );
  }

  upsertSession(input: {
    readonly id: string;
    readonly parentId?: string | null;
    readonly runId?: string | null;
    readonly agent?: string | null;
    readonly startedAt?: string;
  }): void {
    this.db.run(
      `INSERT INTO sessions (id, parent_id, run_id, agent, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         parent_id = COALESCE(sessions.parent_id, excluded.parent_id),
         run_id = COALESCE(sessions.run_id, excluded.run_id),
         agent = COALESCE(excluded.agent, sessions.agent),
         started_at = COALESCE(sessions.started_at, excluded.started_at)`,
      [
        input.id,
        input.parentId ?? null,
        input.runId ?? null,
        input.agent ?? null,
        input.startedAt ?? this.now(),
      ],
    );
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", [id]);
  }

  bindSession(sessionId: string, runId: string, agent?: string | null): void {
    this.db.run(
      `INSERT INTO sessions (id, parent_id, run_id, agent, started_at, ended_at)
       VALUES (?, NULL, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         run_id = excluded.run_id,
         agent = COALESCE(excluded.agent, sessions.agent),
         started_at = COALESCE(sessions.started_at, excluded.started_at)`,
      [sessionId, runId, agent ?? null, this.now()],
    );
  }

  findRunBySession(sessionId: string): RunRow | undefined {
    return this.db.get<RunRow>(
      `SELECT runs.* FROM runs JOIN sessions ON sessions.run_id = runs.id WHERE sessions.id = ?`,
      [sessionId],
    );
  }

  snapshotModels(runId: string, routes: readonly RunModelInput[]): void {
    for (const route of routes) {
      this.db.run(
        `INSERT INTO run_models (run_id, role, model, params_json, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, role) DO UPDATE SET
           model = excluded.model,
           params_json = excluded.params_json,
           source = excluded.source`,
        [
          runId,
          route.role,
          route.model,
          serializeTraceJson(route.params),
          route.source,
        ],
      );
    }
  }

  listRunModels(runId: string): RunModelRow[] {
    const rows = this.db.all<{
      run_id: string;
      role: string;
      model: string | null;
      params_json: string | null;
      source: ModelResolutionSource;
    }>("SELECT * FROM run_models WHERE run_id = ? ORDER BY role", [runId]);
    return rows.map((row) => ({
      run_id: row.run_id,
      role: row.role,
      model: row.model,
      params: parseJsonRecord(row.params_json),
      source: row.source,
    }));
  }
}

export function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
