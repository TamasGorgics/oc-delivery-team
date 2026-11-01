import type { LessonRow } from "../state/lessons";

export const LESSON_EXPORT_DIRNAME = "lessons-export";
export const STALE_MIN_HIT_COUNT = 5;

export interface StaleLesson extends LessonRow {
  readonly reason: "high_hits_without_evidence";
  readonly age_days: number | null;
}

/** Map a lesson role to the Markdown file stem used by `team lessons export`. */
export function lessonExportStem(role: string): string {
  if (role === "*") return "all";
  const normalized = role
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "unknown";
}

export function renderLessonExport(role: string, lessons: readonly LessonRow[]): string {
  const title = role === "*" ? "all roles" : role;
  const lines = [`# Approved lessons: ${title}`, ""];
  for (const lesson of [...lessons].sort((left, right) => left.id - right.id)) {
    const text = lesson.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const stack = lesson.stack_tag && lesson.stack_tag !== "*" ? `[${lesson.stack_tag}] ` : "";
    lines.push(`- ${stack}${text}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Report only. A lesson is a stale candidate when it is approved, has been
 * injected often, and still carries no evidence from its source run. Humans
 * decide whether to retire it.
 */
export function findStaleLessons(
  lessons: readonly LessonRow[],
  now: number = Date.now(),
): StaleLesson[] {
  return lessons
    .filter((lesson) => lesson.status === "approved"
      && lesson.hit_count >= STALE_MIN_HIT_COUNT
      && !hasEvidence(lesson.evidence))
    .sort((left, right) => right.hit_count - left.hit_count || left.id - right.id)
    .map((lesson) => ({
      ...lesson,
      reason: "high_hits_without_evidence",
      age_days: ageDays(lesson.decided_at ?? lesson.created_at, now),
    }));
}

function hasEvidence(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function ageDays(value: string, now: number): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((now - parsed) / 86_400_000));
}
