import type { TeamDatabase } from "./db";
import { redactSecrets, redactText } from "./privacy";

export interface TraceIdentity {
  readonly runId?: string | null;
  readonly sessionId?: string | null;
  readonly agent?: string | null;
  readonly toolCallId?: string | null;
  readonly phase?: string | null;
}

export interface ToolCallTrace {
  readonly runId?: string | null;
  readonly sessionId?: string | null;
  readonly agent?: string | null;
  readonly toolCallId?: string | null;
  readonly tool: string;
  readonly phase?: string | null;
  readonly startedAt?: string | null;
  readonly durationMs?: number | null;
  readonly ok?: boolean | null;
  readonly outputBytes?: number | null;
  readonly input?: unknown;
  readonly outputPreview?: string | null;
}

export interface TraceError {
  readonly at: string;
  readonly operation: string;
  readonly message: string;
}

/**
 * Tracing is deliberately fail-safe. A broken or unavailable database must
 * never turn an otherwise successful tool call into a failure.
 */
export class Tracer {
  private readonly errors: TraceError[] = [];

  constructor(
    private readonly db: TeamDatabase | null,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly onError: (error: TraceError) => void = defaultTraceErrorLogger,
  ) {}

  event(kind: string, data: Record<string, unknown> = {}, identity: TraceIdentity = {}): void {
    if (!this.db) return;
    try {
      const payload: Record<string, unknown> = { ...data };
      if (identity.sessionId) payload.session_id = identity.sessionId;
      if (identity.agent) payload.agent = identity.agent;
      if (identity.toolCallId) payload.tool_call_id = identity.toolCallId;
      if (identity.phase) payload.phase = identity.phase;
      this.db.run(
        "INSERT INTO events (run_id, at, kind, data_json) VALUES (?, ?, ?, ?)",
          [identity.runId ?? null, this.now(), kind, safeJson(redactSecrets(payload))],
      );
    } catch (error) {
      this.record("event", error);
    }
  }

  toolCall(row: ToolCallTrace): void {
    if (!this.db) return;
    try {
      this.db.run(
        `INSERT INTO tool_calls (
          run_id, session_id, agent, tool_call_id, tool, phase,
          started_at, duration_ms, ok, output_bytes, input_json, output_preview
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.runId ?? null,
          row.sessionId ?? null,
          row.agent ?? null,
          row.toolCallId ?? null,
          row.tool,
          row.phase ?? null,
          row.startedAt ?? null,
          row.durationMs ?? null,
          row.ok === undefined || row.ok === null ? null : row.ok ? 1 : 0,
          row.outputBytes ?? null,
          row.input === undefined ? null : safeJson(redactSecrets(row.input)),
          row.outputPreview == null ? null : redactText(row.outputPreview),
        ],
      );
    } catch (error) {
      this.record("toolCall", error);
    }
  }

  getErrors(): readonly TraceError[] {
    return this.errors;
  }

  private record(operation: string, error: unknown): void {
    const entry: TraceError = {
      at: this.now(),
      operation,
      message: error instanceof Error ? error.message : String(error),
    };
    this.errors.push(entry);
    if (this.errors.length > 50) this.errors.shift();
    try {
      this.onError(entry);
    } catch {
      // A logging callback must not break tracing either.
    }
  }
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "bigint") return entry.toString();
      if (entry instanceof Error) return { name: entry.name, message: entry.message };
      return entry;
    });
    return serialized === undefined ? "null" : serialized;
  } catch {
    return JSON.stringify({ error: "unserializable trace data" });
  }
}

function defaultTraceErrorLogger(error: TraceError): void {
  try {
    console.error(`[delivery-team] trace ${error.operation} failed: ${error.message}`);
  } catch {
    // Nothing else can be done if even stderr is unavailable.
  }
}

export { safeJson as serializeTraceJson };
