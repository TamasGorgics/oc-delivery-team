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

export interface ToolCallRow {
  readonly id: number;
  readonly run_id: string | null;
  readonly session_id: string | null;
  readonly agent: string | null;
  readonly tool_call_id: string | null;
  readonly tool: string;
  readonly phase: Phase | null;
  readonly started_at: string | null;
  readonly duration_ms: number | null;
  readonly ok: number | null;
  readonly output_bytes: number | null;
  readonly input_json: string | null;
  readonly output_preview: string | null;
}

export interface MessageRow {
  readonly id: string;
  readonly session_id: string | null;
  readonly run_id: string | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly cost: number | null;
  readonly at: string | null;
}

export interface MessageTotals {
  readonly messages: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost: number;
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

  listEvents(runId: string, limit?: number): EventRow[] {
    if (limit === undefined) {
      return this.db.all<EventRow>(
        "SELECT * FROM events WHERE run_id = ? ORDER BY at, id",
        [runId],
      );
    }
    return this.db.all<EventRow>(
      "SELECT * FROM events WHERE run_id = ? ORDER BY at, id LIMIT ?",
      [runId, Math.max(1, Math.floor(limit))],
    );
  }

  countEvents(runId: string, kind: string): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND kind = ?",
      [runId, kind],
    );
    return row ? Number(row.count) : 0;
  }

  listToolCalls(runId: string, limit?: number): ToolCallRow[] {
    if (limit === undefined) {
      return this.db.all<ToolCallRow>(
        "SELECT * FROM tool_calls WHERE run_id = ? ORDER BY COALESCE(started_at, ''), id",
        [runId],
      );
    }
    return this.db.all<ToolCallRow>(
      "SELECT * FROM tool_calls WHERE run_id = ? ORDER BY COALESCE(started_at, ''), id LIMIT ?",
      [runId, Math.max(1, Math.floor(limit))],
    );
  }

  listRecentToolCalls(runId: string, limit = 10): ToolCallRow[] {
    return this.db.all<ToolCallRow>(
      "SELECT * FROM tool_calls WHERE run_id = ? ORDER BY id DESC LIMIT ?",
      [runId, Math.max(1, limit)],
    );
  }

  countToolCalls(runId: string): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?",
      [runId],
    );
    return row ? Number(row.count) : 0;
  }

  countToolFailures(runId: string): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ? AND ok = 0",
      [runId],
    );
    return row ? Number(row.count) : 0;
  }

  listMessages(runId: string, limit?: number): MessageRow[] {
    if (limit === undefined) {
      return this.db.all<MessageRow>(
        "SELECT * FROM messages WHERE run_id = ? ORDER BY COALESCE(at, ''), id",
        [runId],
      );
    }
    return this.db.all<MessageRow>(
      "SELECT * FROM messages WHERE run_id = ? ORDER BY COALESCE(at, ''), id LIMIT ?",
      [runId, Math.max(1, Math.floor(limit))],
    );
  }

  countMessages(runId: string): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE run_id = ?",
      [runId],
    );
    return row ? Number(row.count) : 0;
  }

  messageTotals(runId: string): MessageTotals {
    const row = this.db.get<{
      messages: number;
      tokens_in: number | null;
      tokens_out: number | null;
      cost: number | null;
    }>(
      `SELECT COUNT(*) AS messages,
        COALESCE(SUM(tokens_in), 0) AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out,
        COALESCE(SUM(cost), 0) AS cost
       FROM messages WHERE run_id = ?`,
      [runId],
    );
    return {
      messages: row ? Number(row.messages) : 0,
      tokens_in: row ? Number(row.tokens_in ?? 0) : 0,
      tokens_out: row ? Number(row.tokens_out ?? 0) : 0,
      cost: row ? Number(row.cost ?? 0) : 0,
    };
  }

  listSessionsForRun(runId: string): SessionRow[] {
    return this.db.all<SessionRow>(
      "SELECT * FROM sessions WHERE run_id = ? ORDER BY COALESCE(started_at, ''), id",
      [runId],
    );
  }

  updateSessionAgent(sessionId: string, agent: string): void {
    this.db.run(
      `INSERT INTO sessions (id, parent_id, run_id, agent, started_at, ended_at)
       VALUES (?, NULL, NULL, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET agent = excluded.agent`,
      [sessionId, agent, this.now()],
    );
  }

  endSession(sessionId: string, at: string = this.now()): void {
    this.db.run("UPDATE sessions SET ended_at = ? WHERE id = ?", [at, sessionId]);
  }

  upsertMessage(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly runId?: string | null;
    readonly agent?: string | null;
    readonly model?: string | null;
    readonly tokensIn?: number | null;
    readonly tokensOut?: number | null;
    readonly cost?: number | null;
    readonly at?: string | null;
  }): void {
    const runId = input.runId ?? this.resolveBoundRun(input.sessionId)?.id ?? null;
    this.db.run(
      `INSERT INTO messages (
        id, session_id, run_id, agent, model, tokens_in, tokens_out, cost, at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        run_id = COALESCE(messages.run_id, excluded.run_id),
        agent = COALESCE(excluded.agent, messages.agent),
        model = COALESCE(excluded.model, messages.model),
        tokens_in = excluded.tokens_in,
        tokens_out = excluded.tokens_out,
        cost = excluded.cost,
        at = excluded.at`,
      [
        input.id,
        input.sessionId,
        runId,
        input.agent ?? null,
        input.model ?? null,
        input.tokensIn ?? null,
        input.tokensOut ?? null,
        input.cost ?? null,
        input.at ?? this.now(),
      ],
    );
  }

  assignMessagesToRun(sessionId: string, runId: string): void {
    this.db.run(
      "UPDATE messages SET run_id = ? WHERE session_id = ? AND run_id IS NULL",
      [runId, sessionId],
    );
  }

  assignSessionTreeToRun(sessionId: string, runId: string): void {
    this.db.run(
      `WITH RECURSIVE descendants(id) AS (
        SELECT ?
        UNION
        SELECT child.id FROM sessions AS child
        JOIN descendants AS parent ON child.parent_id = parent.id
      )
      UPDATE sessions SET run_id = ?
      WHERE run_id IS NULL AND id IN (SELECT id FROM descendants)`,
      [sessionId, runId],
    );
    this.db.run(
      `WITH RECURSIVE descendants(id) AS (
        SELECT ?
        UNION
        SELECT child.id FROM sessions AS child
        JOIN descendants AS parent ON child.parent_id = parent.id
      )
      UPDATE messages SET run_id = ?
      WHERE run_id IS NULL AND session_id IN (SELECT id FROM descendants)`,
      [sessionId, runId],
    );
  }

  latestEvent(kind: string): EventRow | undefined {
    return this.db.get<EventRow>(
      "SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1",
      [kind],
    );
  }

  hasEvent(runId: string, kind: string): boolean {
    return this.db.get<{ found: number }>(
      "SELECT 1 AS found FROM events WHERE run_id = ? AND kind = ? LIMIT 1",
      [runId, kind],
    ) !== undefined;
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
    const bound = this.getSession(input.id)?.run_id;
    if (bound) this.assignSessionTreeToRun(input.id, bound);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>("SELECT * FROM sessions WHERE id = ?", [id]);
  }

  /**
   * Resolve a run strictly through the session or its ancestors. Unlike
   * resolveSessionRun this never falls back to a single open run, which keeps
   * event ingestion from binding unrelated child sessions.
   */
  resolveBoundRun(sessionId: string): RunRow | undefined {
    const seen = new Set<string>();
    let current = this.getSession(sessionId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.run_id) {
        const run = this.getRun(current.run_id);
        if (run) return run;
      }
      if (!current.parent_id) return undefined;
      current = this.getSession(current.parent_id);
    }
    return undefined;
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
    this.assignSessionTreeToRun(sessionId, runId);
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

export type SessionRunResolution =
  | { readonly ok: true; readonly run: RunRow; readonly singleOpen: boolean }
  | { readonly ok: false; readonly code: "run_not_found" | "run_ambiguous"; readonly message: string };

/**
 * Resolve a run from a session without mutating the session. Tools may bind the
 * returned single-open run, but the gate stays read-only.
 */
export function resolveSessionRun(runs: RunRepository, sessionId: string): SessionRunResolution {
  const bound = runs.resolveBoundRun(sessionId);
  if (bound) return { ok: true, run: bound, singleOpen: false };

  const open = runs.listOpenRuns();
  if (open.length === 1) {
    return { ok: true, run: open[0] as RunRow, singleOpen: true };
  }
  if (open.length > 1) {
    return {
      ok: false,
      code: "run_ambiguous",
      message: `Multiple open runs found (${open.map((run) => run.id).join(", ")}). Pass the run id explicitly.`,
    };
  }
  return {
    ok: false,
    code: "run_not_found",
    message: "No open delivery-team run was found. Call team_start first or pass a run id.",
  };
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
