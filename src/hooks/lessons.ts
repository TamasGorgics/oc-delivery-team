import { readFileSync } from "node:fs";
import { appendSystemSection, roleIdFromAgent } from "../compat";
import { parseStackProfile, stackLanguages } from "../stack/profile";
import { runArtifactPath } from "../state/paths";
import { resolveSessionRun, type RunRow } from "../state/runs";
import type { LessonRow } from "../state/lessons";
import type { ToolRuntime } from "../tools/runtime";

export const LESSON_SECTION_HEADER = "## Team lessons (approved, from past retros)";
const SPEC_QUERY_CHARS = 4_000;
const FOOTER_BLOCK = /<!--\s*team-footer\s*-->[\s\S]*?<!--\s*\/team-footer\s*-->/g;

export interface LessonInjectionEvent {
  readonly sessionID?: unknown;
  readonly agent?: unknown;
  system?: unknown;
}

export type LessonInjectionOutcome =
  | {
      readonly kind: "injected";
      readonly runId: string;
      readonly lessonIds: readonly number[];
      readonly chars: number;
    }
  | { readonly kind: "empty"; readonly runId: string; readonly reason: "no_lessons" | "budget" }
  | { readonly kind: "skipped"; readonly reason: string };

export interface LessonSection {
  readonly text: string;
  readonly lessons: readonly LessonRow[];
  readonly chars: number;
}

/**
 * Select lessons in ranked order until the text budget is exhausted. The
 * injected section header and bullet labels are deliberately excluded from
 * `chars`; `lessons.budgetChars` is a hard cap on lesson text, as specified.
 */
export function selectLessonSection(
  rows: readonly LessonRow[],
  budgetChars: number,
): LessonSection {
  const budget = Number.isFinite(budgetChars) ? Math.max(0, Math.floor(budgetChars)) : 0;
  const selected: Array<{ readonly row: LessonRow; readonly text: string }> = [];
  let chars = 0;

  for (const row of rows) {
    const text = row.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const length = [...text].length;
    if (chars + length > budget) break;
    selected.push({ row, text });
    chars += length;
  }

  if (selected.length === 0) return { text: "", lessons: [], chars: 0 };

  const text = [
    LESSON_SECTION_HEADER,
    ...selected.map(({ row, text: lessonText }) => `- [${row.role}] ${lessonText}`),
  ].join("\n");

  return { text, lessons: selected.map(({ row }) => row), chars };
}

export function createLessonInjectionHandler(runtime: ToolRuntime) {
  return (event: LessonInjectionEvent): LessonInjectionOutcome => {
    try {
      return injectApprovedLessons(runtime, event);
    } catch (error) {
      runtime.trace.event(
        "lessons.injection_error",
        { message: errorMessage(error) },
        identity(event),
      );
      return { kind: "skipped", reason: "error" };
    }
  };
}

export function injectApprovedLessons(
  runtime: ToolRuntime,
  event: LessonInjectionEvent,
): LessonInjectionOutcome {
  if (!runtime.runs || !runtime.lessons) {
    return { kind: "skipped", reason: "database_unavailable" };
  }

  const sessionId = readString(event.sessionID);
  if (!sessionId) return { kind: "skipped", reason: "session_unavailable" };

  const resolution = resolveSessionRun(runtime.runs, sessionId);
  if (!resolution.ok) return { kind: "skipped", reason: resolution.code };

  const run = resolution.run;
  const role = roleIdFromAgent(event.agent);
  const languages = runLanguages(run);
  const query = buildRunQuery(runtime.config.rootDir, run);
  const rows = runtime.lessons.rankApproved({
    ...(role ? { role } : {}),
    languages,
    ...(query.text ? { query: query.text } : {}),
    topN: runtime.config.lessons.topN,
  });
  const selection = selectLessonSection(rows, runtime.config.lessons.budgetChars);
  if (!selection.text) {
    return {
      kind: "empty",
      runId: run.id,
      reason: rows.length === 0 ? "no_lessons" : "budget",
    };
  }

  const target = event as { system?: unknown };
  const appended = appendSystemSection(target.system, selection.text);
  if (!appended.ok) {
    runtime.trace.event(
      "lessons.injection_skipped",
      { reason: appended.reason },
      { ...identity(event), runId: run.id, phase: run.phase },
    );
    return { kind: "skipped", reason: "system_shape" };
  }
  target.system = appended.system;

  const lessonIds = selection.lessons.map((lesson) => lesson.id);
  runtime.lessons.recordHits(lessonIds);
  runtime.trace.event(
    "lessons.injected",
    {
      lesson_ids: lessonIds,
      count: lessonIds.length,
      chars: selection.chars,
      top_n: runtime.config.lessons.topN,
      budget_chars: runtime.config.lessons.budgetChars,
      role: role ?? null,
      languages,
      spec_used: query.specUsed,
    },
    { ...identity(event), runId: run.id, phase: run.phase },
  );

  return { kind: "injected", runId: run.id, lessonIds, chars: selection.chars };
}

function buildRunQuery(
  rootDir: string,
  run: RunRow,
): { readonly text: string; readonly specUsed: boolean } {
  const spec = readSpecSummary(rootDir, run.id);
  if (!spec) return { text: run.title.trim(), specUsed: false };
  return { text: `${run.title}\n${spec}`, specUsed: true };
}

function readSpecSummary(rootDir: string, runId: string): string | undefined {
  try {
    const raw = readFileSync(runArtifactPath(rootDir, runId, "spec.md"), "utf8");
    const text = raw.replace(FOOTER_BLOCK, " ").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, SPEC_QUERY_CHARS) : undefined;
  } catch {
    return undefined;
  }
}

function runLanguages(run: RunRow): string[] {
  if (!run.stack_json) return [];
  try {
    const parsed: unknown = JSON.parse(run.stack_json);
    const profile = parseStackProfile(parsed).profile;
    return profile ? stackLanguages(profile) : [];
  } catch {
    return [];
  }
}

function identity(event: LessonInjectionEvent | null | undefined): {
  readonly sessionId?: string;
  readonly agent?: string;
} {
  if (!event) return {};
  const sessionId = readString(event.sessionID);
  const agent = readString(event.agent);
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(agent ? { agent } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
