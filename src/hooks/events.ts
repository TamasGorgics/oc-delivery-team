import path from "node:path";
import type { PluginContext } from "../compat";
import type { RunRepository } from "../state/runs";
import type { ToolRuntime } from "../tools/runtime";

type SessionEventType =
  | "session.created"
  | "session.agent.selected"
  | "session.model.selected"
  | "session.step.ended"
  | "session.execution.started"
  | "session.execution.succeeded"
  | "session.execution.failed"
  | "session.execution.interrupted"
  | "session.idle";

const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  "session.created",
  "session.agent.selected",
  "session.model.selected",
  "session.step.ended",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
];

interface OpenCodeEventLike {
  readonly created?: number;
  readonly type: string;
  readonly data?: unknown;
  readonly location?: { readonly directory?: string };
}

interface EventStream {
  subscribe(options: {
    readonly signal: AbortSignal;
    readonly types?: readonly string[];
  }): AsyncIterable<OpenCodeEventLike>;
}

export interface EventIngestStatus {
  readonly status: "subscribed" | "unavailable" | "closed";
  readonly error?: string;
}

export interface EventIngestOptions {
  readonly projectDir: string;
  readonly onWarning?: (message: string) => void;
  readonly shutdownTimeoutMs?: number;
}

export interface EventIngestHandle {
  readonly dispose: () => Promise<void>;
  status(): EventIngestStatus;
}

/**
 * Subscribe to the host event stream in the background. Setup never waits for
 * the stream, and cleanup aborts it without hanging plugin shutdown.
 */
export function startEventIngest(
  context: PluginContext,
  runtime: ToolRuntime,
  options: EventIngestOptions,
): EventIngestHandle {
  if (!runtime.runs) {
    return unavailable("The delivery-team database is unavailable.");
  }

  const controller = new AbortController();
  const ingestor = new SessionEventIngestor(runtime, runtime.runs, options.projectDir);
  let current: EventIngestStatus = { status: "subscribed" };

  const warn = (message: string): void => {
    try {
      options.onWarning?.(message);
    } catch {
      // Warning collection is best-effort.
    }
  };

  const fail = (message: string): void => {
    if (current.status !== "subscribed") return;
    current = { status: "unavailable", error: message };
    ingestor.trace("events.error", { message });
    warn(`events.stream: ${message}`);
  };

  let stream: AsyncIterable<OpenCodeEventLike>;
  try {
    const domain = context.event as unknown as EventStream;
    stream = domain.subscribe({
      signal: controller.signal,
      types: SESSION_EVENT_TYPES,
    });
  } catch (error) {
    const message = errorMessage(error);
    current = { status: "unavailable", error: message };
    ingestor.trace("events.error", { message });
    warn(`events.subscribe: ${message}`);
    return {
      dispose: async () => {},
      status: () => current,
    };
  }

  const done = (async () => {
    try {
      for await (const event of stream) {
        if (controller.signal.aborted) break;
        ingestor.handle(event);
      }
      if (!controller.signal.aborted) fail("The event stream ended.");
    } catch (error) {
      if (!controller.signal.aborted) fail(errorMessage(error));
    }
  })();

  return {
    status: () => current,
    dispose: async () => {
      controller.abort();
      if (current.status === "subscribed") current = { status: "closed" };
      await Promise.race([done, delay(options.shutdownTimeoutMs ?? 500)]);
    },
  };
}

class SessionEventIngestor {
  private readonly models = new Map<string, string>();

  constructor(
    private readonly runtime: ToolRuntime,
    private readonly runs: RunRepository,
    private readonly projectDir: string,
  ) {}

  handle(event: OpenCodeEventLike): void {
    try {
      this.dispatch(event);
    } catch (error) {
      this.trace("events.error", {
        type: event.type,
        message: errorMessage(error),
      });
    }
  }

  trace(kind: string, data: Record<string, unknown>, sessionId?: string, runId?: string): void {
    this.runtime.trace.event(
      kind,
      data,
      sessionId ? { sessionId, ...(runId ? { runId } : {}) } : runId ? { runId } : {},
    );
  }

  private dispatch(event: OpenCodeEventLike): void {
    const data = record(event.data);
    const sessionId = stringValue(data.sessionID);
    if (!sessionId) return;

    if (event.type === "session.created") {
      this.onCreated(event, sessionId, data);
      return;
    }

    const location = directoryOf(event);
    if (location && !sameDirectory(location, this.projectDir)) return;

    let session = this.runs.getSession(sessionId);
    if (!session) {
      if (!location || !sameDirectory(location, this.projectDir)) return;
      this.runs.upsertSession({ id: sessionId, startedAt: this.eventTime(event) });
      session = this.runs.getSession(sessionId);
      if (!session) return;
    }

    switch (event.type) {
      case "session.agent.selected": {
        const agent = stringValue(data.agent);
        if (agent) this.runs.updateSessionAgent(sessionId, agent);
        break;
      }
      case "session.model.selected": {
        const model = modelReference(data.model);
        if (model) this.models.set(sessionId, model);
        break;
      }
      case "session.step.ended": {
        this.onStepEnded(event, sessionId, session, data);
        break;
      }
      case "session.execution.failed": {
        const runId = this.runs.resolveBoundRun(sessionId)?.id;
        const failure = record(data.error);
        this.trace(
          "session.failed",
          {
            type: stringValue(failure.type) ?? "unknown",
            message: stringValue(failure.message) ?? "Agent execution failed.",
          },
          sessionId,
          runId,
        );
        break;
      }
      case "session.idle": {
        this.runs.endSession(sessionId, this.eventTime(event));
        const runId = this.runs.resolveBoundRun(sessionId)?.id;
        this.trace("session.ended", {}, sessionId, runId);
        break;
      }
      default:
        break;
    }
  }

  private onCreated(
    event: OpenCodeEventLike,
    sessionId: string,
    data: Record<string, unknown>,
  ): void {
    const location = stringValue(record(data.location).directory) ?? directoryOf(event);
    if (!location || !sameDirectory(location, this.projectDir)) return;

    const parentId = stringValue(data.parentID);
    const agent = stringValue(data.agent);
    const model = modelReference(data.model);
    if (model) this.models.set(sessionId, model);

    const existing = this.runs.getSession(sessionId);
    const inheritedRunId = existing?.run_id
      ?? (parentId ? this.runs.resolveBoundRun(parentId)?.id : undefined);
    this.runs.upsertSession({
      id: sessionId,
      parentId,
      agent,
      startedAt: existing?.started_at ?? this.eventTime(event),
      ...(inheritedRunId ? { runId: inheritedRunId } : {}),
    });
    const run = this.runs.resolveBoundRun(sessionId);
    this.trace(
      "session.started",
      {
        ...(parentId ? { parent_id: parentId } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
      },
      sessionId,
      run?.id,
    );
  }

  private onStepEnded(
    event: OpenCodeEventLike,
    sessionId: string,
    session: { readonly agent: string | null },
    data: Record<string, unknown>,
  ): void {
    const messageId = stringValue(data.assistantMessageID);
    if (!messageId) return;
    const tokens = record(data.tokens);
    const cost = numberValue(data.cost);
    this.runs.upsertMessage({
      id: messageId,
      sessionId,
      agent: session.agent,
      model: this.modelFor(sessionId) ?? null,
      tokensIn: numberValue(tokens.input),
      tokensOut: numberValue(tokens.output),
      cost,
      at: this.eventTime(event),
    });
  }

  private modelFor(sessionId: string): string | undefined {
    const seen = new Set<string>();
    let current: string | undefined = sessionId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const direct = this.models.get(current);
      if (direct) return direct;
      current = this.runs.getSession(current)?.parent_id ?? undefined;
    }
    return undefined;
  }

  private eventTime(event: OpenCodeEventLike): string {
    const created = numberValue(event.created);
    const date = created !== null ? new Date(created) : new Date();
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }
}

function directoryOf(event: OpenCodeEventLike): string | undefined {
  const direct = stringValue(event.location?.directory);
  if (direct) return direct;
  return stringValue(record(record(event.data).location).directory);
}

function modelReference(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const model = record(value);
  const providerID = stringValue(model.providerID);
  const id = stringValue(model.id);
  if (!providerID || !id) return undefined;
  const variant = stringValue(model.variant);
  return `${providerID}/${id}${variant ? `#${variant}` : ""}`;
}

function sameDirectory(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, ms));
    (timer as { unref?: () => void }).unref?.();
  });
}

function unavailable(message: string): EventIngestHandle {
  return {
    dispose: async () => {},
    status: () => ({ status: "unavailable", error: message }),
  };
}
