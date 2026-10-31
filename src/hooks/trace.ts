import type { PluginContext } from "../compat";
import type { Phase } from "../state/phases";
import {
  previewText,
  redactSecrets,
  redactText,
  truncatePreview,
  utf8Bytes,
} from "../state/privacy";
import type { ToolRuntime } from "../tools/runtime";

export interface ToolBeforeEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly input: unknown;
}

export type ToolAfterEvent =
  | (ToolBeforeEvent & {
      readonly status: "completed";
      readonly result: unknown;
    })
  | (ToolBeforeEvent & {
      readonly status: "error";
      readonly error: { readonly message: string };
    });

export interface TraceHookOptions {
  readonly now?: () => number;
}

export interface TraceSpan {
  readonly key: string;
  readonly tool: string;
  readonly sessionId: string;
  readonly agent: string;
  readonly toolCallId: string;
  readonly messageId: string;
  readonly startedAt: number;
  readonly runId?: string;
  readonly phase?: Phase;
}

const MAX_KEYS = 256;
const MAX_STACK = 16;

/**
 * Bounded, in-memory correlation between execute.before and execute.after.
 * Hosts can fire nested calls with the same call ID (V18), so each
 * session + call + tool key keeps a small LIFO stack.
 */
export class TraceSpans {
  private readonly stacks = new Map<string, TraceSpan[]>();
  private readonly keys: string[] = [];

  push(span: TraceSpan): void {
    const stack = this.stacks.get(span.key);
    if (!stack) {
      this.keys.push(span.key);
      while (this.keys.length > MAX_KEYS) {
        const oldest = this.keys.shift();
        if (oldest !== undefined) this.stacks.delete(oldest);
      }
    }
    const target = stack ?? [];
    target.push(span);
    if (target.length > MAX_STACK) target.shift();
    this.stacks.set(span.key, target);
  }

  pop(sessionId: string, toolCallId: string, tool: string): TraceSpan | undefined {
    const key = spanKey(sessionId, toolCallId, tool);
    const stack = this.stacks.get(key);
    if (!stack || stack.length === 0) return undefined;
    const span = stack.pop();
    if (stack.length === 0) {
      this.stacks.delete(key);
      const index = this.keys.indexOf(key);
      if (index >= 0) this.keys.splice(index, 1);
    }
    return span;
  }

  size(): number {
    let total = 0;
    for (const stack of this.stacks.values()) total += stack.length;
    return total;
  }
}

export function createTraceBeforeHandler(
  runtime: ToolRuntime,
  spans: TraceSpans = new TraceSpans(),
  options: TraceHookOptions = {},
): (event: ToolBeforeEvent) => void {
  const now = options.now ?? Date.now;
  return (event) => {
    try {
      const sessionId = String(event.sessionID);
      const agent = String(event.agent);
      const toolCallId = String(event.id);
      const run = resolveTraceRun(runtime, sessionId);
      spans.push({
        key: spanKey(sessionId, toolCallId, event.tool),
        tool: event.tool,
        sessionId,
        agent,
        toolCallId,
        messageId: String(event.messageID),
        startedAt: now(),
        ...(run.runId ? { runId: run.runId } : {}),
        ...(run.phase ? { phase: run.phase } : {}),
      });

      runtime.trace.event(
        "tool.before",
        {
          tool: event.tool,
          message_id: String(event.messageID),
          input_keys: Object.keys(inputRecord(event.input)),
        },
        {
          sessionId,
          agent,
          toolCallId,
          ...(run.runId ? { runId: run.runId } : {}),
          ...(run.phase ? { phase: run.phase } : {}),
        },
      );
    } catch (error) {
      safeTraceError(runtime, "execute.before", error);
    }
  };
}

export function createTraceAfterHandler(
  runtime: ToolRuntime,
  spans: TraceSpans = new TraceSpans(),
  options: TraceHookOptions = {},
): (event: ToolAfterEvent) => void {
  const now = options.now ?? Date.now;
  return (event) => {
    try {
      const sessionId = String(event.sessionID);
      const agent = String(event.agent);
      const toolCallId = String(event.id);
      const span = spans.pop(sessionId, toolCallId, event.tool);
      const run = span?.runId
        ? { runId: span.runId, phase: span.phase }
        : resolveTraceRun(runtime, sessionId);

      const completed = event.status === "completed";
      const resultText = completed ? previewText(event.result) : redactText(errorText(event.error));
      const outputOk = completed && resultOutputOk(event.result);
      const input = runtime.config.trace.captureInput
        ? redactSecrets(event.input)
        : undefined;
      const preview = runtime.config.trace.previewChars > 0
        ? truncatePreview(resultText, runtime.config.trace.previewChars)
        : null;

      runtime.trace.toolCall({
        runId: run.runId ?? null,
        sessionId,
        agent,
        toolCallId,
        tool: event.tool,
        phase: run.phase ?? null,
        startedAt: span ? new Date(span.startedAt).toISOString() : null,
        durationMs: span ? Math.max(0, now() - span.startedAt) : null,
        ok: completed ? outputOk : false,
        outputBytes: utf8Bytes(resultText),
        ...(input !== undefined ? { input } : {}),
        outputPreview: preview,
      });
    } catch (error) {
      safeTraceError(runtime, "execute.after", error);
    }
  };
}

export async function registerTraceHooks(
  context: PluginContext,
  runtime: ToolRuntime,
  options: TraceHookOptions = {},
): Promise<{ readonly dispose: () => Promise<void> }> {
  const spans = new TraceSpans();
  const before = await context.tool.hook(
    "execute.before",
    createTraceBeforeHandler(runtime, spans, options),
  );
  try {
    const after = await context.tool.hook(
      "execute.after",
      createTraceAfterHandler(runtime, spans, options),
    );
    return {
      dispose: async () => {
        await after.dispose();
        await before.dispose();
      },
    };
  } catch (error) {
    try {
      await before.dispose();
    } catch {
      // Preserve the registration error.
    }
    throw error;
  }
}

function resolveTraceRun(
  runtime: ToolRuntime,
  sessionId: string,
): { readonly runId?: string; readonly phase?: Phase } {
  if (!runtime.runs) return {};
  try {
    const run = runtime.runs.resolveBoundRun(sessionId)
      ?? (runtime.runs.listOpenRuns().length === 1 ? runtime.runs.listOpenRuns()[0] : undefined);
    if (!run) return {};
    return { runId: run.id, phase: run.phase };
  } catch {
    return {};
  }
}

function resultOutputOk(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return true;
  const output = (result as Record<string, unknown>).output;
  if (typeof output !== "object" || output === null) return true;
  return (output as Record<string, unknown>).ok !== false;
}

function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return typeof error === "string" ? error : JSON.stringify(error ?? "tool error");
}

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function spanKey(sessionId: string, toolCallId: string, tool: string): string {
  return `${sessionId}\u0000${toolCallId}\u0000${tool}`;
}

function safeTraceError(runtime: ToolRuntime, hook: string, error: unknown): void {
  try {
    runtime.trace.event("trace.error", {
      hook,
      message: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // Tracing must never escape a hook.
  }
}
