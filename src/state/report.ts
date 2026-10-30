import { writeFileSync } from "node:fs";
import path from "node:path";
import type { NoteRow, PhaseTransitionRow, RunRow } from "./runs";
import { parseJsonRecord } from "./runs";
import { ensureDirectory, runDirectory } from "./paths";

export interface ReportInput {
  readonly run: RunRow;
  readonly transitions: readonly PhaseTransitionRow[];
  readonly loops: readonly { readonly phase: string; readonly count: number }[];
  readonly notes: readonly NoteRow[];
  readonly events: readonly { readonly kind: string; readonly at: string; readonly data_json: string | null }[];
  readonly now?: string;
}

export function renderRunReport(input: ReportInput): string {
  const now = input.now ?? new Date().toISOString();
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
      const end = next?.at ?? now;
      lines.push(`| ${transition.to_phase} | ${transition.at} | ${formatDuration(parseTime(end) - parseTime(transition.at))} |`);
    });
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
