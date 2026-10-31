import { writeFileSync } from "node:fs";
import path from "node:path";
import type {
  EventRow,
  MessageRow,
  NoteRow,
  PhaseTransitionRow,
  RunRow,
  SessionRow,
  ToolCallRow,
} from "./runs";
import { parseJsonRecord } from "./runs";
import { ensureDirectory, runDirectory } from "./paths";

export interface ReportInput {
  readonly run: RunRow;
  readonly transitions: readonly PhaseTransitionRow[];
  readonly loops: readonly { readonly phase: string; readonly count: number }[];
  readonly notes: readonly NoteRow[];
  readonly events: readonly Pick<EventRow, "kind" | "at" | "data_json">[];
  readonly toolCalls?: readonly ToolCallRow[];
  readonly messages?: readonly MessageRow[];
  readonly sessions?: readonly SessionRow[];
  readonly now?: string;
}

export function renderRunReport(input: ReportInput): string {
  const now = input.now ?? new Date().toISOString();
  const toolCalls = input.toolCalls ?? [];
  const messages = input.messages ?? [];
  const sessions = input.sessions ?? [];
  const lines: string[] = [];
  lines.push(`# Delivery run ${input.run.id}: ${input.run.title}`);
  lines.push("");
  lines.push(`- Status: ${input.run.status}`);
  lines.push(`- Phase: ${input.run.phase}`);
  lines.push(`- Created: ${input.run.created_at}`);
  if (input.run.closed_at) lines.push(`- Closed: ${input.run.closed_at}`);
  if (input.run.description) lines.push(`- Description: ${input.run.description}`);
  lines.push("");

  lines.push("## Phase durations");
  lines.push("");
  if (input.transitions.length === 0) {
    lines.push("_No transitions recorded._");
  } else {
    lines.push("| Phase | Started | Duration |");
    lines.push("|---|---|---|");
    input.transitions.forEach((transition, index) => {
      const next = input.transitions[index + 1];
      const end = next?.at ?? input.run.closed_at ?? now;
      lines.push(`| ${transition.to_phase} | ${transition.at} | ${formatDuration(parseTime(end) - parseTime(transition.at))} |`);
    });
  }
  lines.push("");

  lines.push("## Tool calls");
  lines.push("");
  if (toolCalls.length === 0) {
    lines.push("_No tool calls recorded._");
  } else {
    const failures = toolCalls.filter((row) => row.ok === 0).length;
    const duration = toolCalls.reduce((total, row) => total + number(row.duration_ms), 0);
    const outputBytes = toolCalls.reduce((total, row) => total + number(row.output_bytes), 0);
    lines.push(
      `${toolCalls.length} calls, ${failures} failed, ${formatDuration(duration)} total, ${outputBytes} output bytes.`,
    );
    lines.push("");
    lines.push("| Tool | Calls | Failures | Duration | Output bytes |");
    lines.push("|---|---:|---:|---:|---:|");
    for (const group of groupToolCalls(toolCalls, (row) => row.tool)) {
      lines.push(
        `| ${group.key} | ${group.calls} | ${group.failures} | ${formatDuration(group.duration)} | ${group.outputBytes} |`,
      );
    }
    const byAgent = groupToolCalls(toolCalls, (row) => row.agent ?? "unknown");
    lines.push("");
    lines.push("| Agent | Calls | Failures |");
    lines.push("|---|---:|---:|");
    for (const group of byAgent) {
      lines.push(`| ${group.key} | ${group.calls} | ${group.failures} |`);
    }
    const failed = toolCalls.filter((row) => row.ok === 0).slice(0, 20);
    if (failed.length > 0) {
      lines.push("");
      lines.push("### Failed tool calls");
      lines.push("");
      for (const row of failed) {
        lines.push(
          `- ${row.started_at ?? "unknown time"} [${row.tool}] ${row.agent ?? "unknown agent"} in ${row.phase ?? "unknown phase"}`,
        );
      }
    }
  }
  lines.push("");

  lines.push("## Messages");
  lines.push("");
  if (messages.length === 0) {
    lines.push("_No messages recorded. Event ingestion may be unavailable._");
  } else {
    const totals = messageTotals(messages);
    lines.push(
      `${totals.messages} messages, ${totals.tokensIn} input tokens, ${totals.tokensOut} output tokens, ${formatCost(totals.cost)} total cost.`,
    );
    lines.push("");
    lines.push("| Agent | Model | Messages | Tokens in | Tokens out | Cost |");
    lines.push("|---|---|---:|---:|---:|---:|");
    for (const group of groupMessages(messages)) {
      lines.push(
        `| ${group.agent} | ${group.model} | ${group.messages} | ${group.tokensIn} | ${group.tokensOut} | ${formatCost(group.cost)} |`,
      );
    }
    lines.push(
      `| **Total** | | **${totals.messages}** | **${totals.tokensIn}** | **${totals.tokensOut}** | **${formatCost(totals.cost)}** |`,
    );
  }
  lines.push("");

  lines.push("## Sessions");
  lines.push("");
  if (sessions.length === 0) {
    lines.push("_No sessions recorded._");
  } else {
    lines.push("| Session | Parent | Agent | Started | Ended |");
    lines.push("|---|---|---|---|---|");
    for (const session of sessions) {
      lines.push(
        `| ${session.id} | ${session.parent_id ?? ""} | ${session.agent ?? ""} | ${session.started_at ?? ""} | ${session.ended_at ?? ""} |`,
      );
    }
  }
  lines.push("");

  lines.push("## Loops");
  lines.push("");
  if (input.loops.length === 0) {
    lines.push("_No loops used._");
  } else {
    for (const loop of input.loops) lines.push(`- ${loop.phase}: ${loop.count}`);
  }
  lines.push("");

  lines.push("## Gate denials");
  lines.push("");
  const denials = input.events.filter((event) => event.kind === "gate.denied");
  const unresolved = input.events.filter((event) => event.kind === "gate.unresolved").length;
  if (unresolved > 0) lines.push(`Unresolved gate evaluations: ${unresolved}.`);
  if (denials.length === 0) {
    lines.push("_No gate denials._");
  } else {
    for (const denial of denials) {
      const data = parseJsonRecord(denial.data_json);
      const phase = typeof data.phase === "string" ? data.phase : "unknown phase";
      const message = typeof data.message === "string" ? data.message : "denied";
      const code = typeof data.code === "string" ? `[${data.code}] ` : "";
      lines.push(`- ${denial.at} [${phase}] ${code}${message}`);
    }
  }
  lines.push("");

  lines.push("## Notes");
  lines.push("");
  if (input.notes.length === 0) {
    lines.push("_No notes recorded._");
  } else {
    for (const note of input.notes) {
      lines.push(`- ${note.at} [${note.kind}] ${note.text}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function writeRunReport(rootDir: string, input: ReportInput): string {
  const directory = ensureDirectory(runDirectory(rootDir, input.run.id));
  const reportPath = path.join(directory, "report.md");
  writeFileSync(reportPath, renderRunReport(input), "utf8");
  return reportPath;
}

interface ToolGroup {
  readonly key: string;
  readonly calls: number;
  readonly failures: number;
  readonly duration: number;
  readonly outputBytes: number;
}

function groupToolCalls(
  rows: readonly ToolCallRow[],
  keyOf: (row: ToolCallRow) => string,
): ToolGroup[] {
  const groups = new Map<string, { calls: number; failures: number; duration: number; outputBytes: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? { calls: 0, failures: 0, duration: 0, outputBytes: 0 };
    group.calls += 1;
    if (row.ok === 0) group.failures += 1;
    group.duration += number(row.duration_ms);
    group.outputBytes += number(row.output_bytes);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...group }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

interface MessageGroup {
  readonly agent: string;
  readonly model: string;
  readonly messages: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cost: number;
}

function groupMessages(rows: readonly MessageRow[]): MessageGroup[] {
  const groups = new Map<string, MessageGroup>();
  for (const row of rows) {
    const agent = row.agent ?? "unknown";
    const model = row.model ?? "unknown";
    const key = `${agent}\u0000${model}`;
    const group = groups.get(key) ?? {
      agent,
      model,
      messages: 0,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
    };
    groups.set(key, {
      ...group,
      messages: group.messages + 1,
      tokensIn: group.tokensIn + number(row.tokens_in),
      tokensOut: group.tokensOut + number(row.tokens_out),
      cost: group.cost + number(row.cost),
    });
  }
  return [...groups.values()].sort((left, right) =>
    left.agent.localeCompare(right.agent) || left.model.localeCompare(right.model));
}

function messageTotals(rows: readonly MessageRow[]): {
  readonly messages: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cost: number;
} {
  return {
    messages: rows.length,
    tokensIn: rows.reduce((total, row) => total + number(row.tokens_in), 0),
    tokensOut: rows.reduce((total, row) => total + number(row.tokens_out), 0),
    cost: rows.reduce((total, row) => total + number(row.cost), 0),
  };
}

function number(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(6)}`;
}
