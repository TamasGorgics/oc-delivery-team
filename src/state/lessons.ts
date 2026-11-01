import { isRoleId, type RoleId } from "../roles";
import type { TeamDatabase } from "./db";

export type LessonStatus = "proposed" | "approved" | "retired" | "rejected";
export type LessonRole = RoleId | "*";

export const LESSON_STATUSES = ["proposed", "approved", "retired", "rejected"] as const;

export const MIN_LESSON_CHARS = 20;
export const MAX_LESSON_CHARS = 300;
export const MAX_LESSONS_PER_RUN = 10;
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.8;

export interface LessonRow {
  readonly id: number;
  readonly role: string;
  readonly text: string;
  readonly evidence: string | null;
  readonly source_run: string | null;
  readonly stack_tag: string;
  readonly status: LessonStatus;
  readonly hit_count: number;
  readonly created_at: string;
  readonly decided_at: string | null;
}

export interface InsertLessonInput {
  readonly role: LessonRole;
  readonly text: string;
  readonly evidence?: string;
  readonly sourceRun?: string;
  readonly stackTag: string;
}

export interface LessonListFilter {
  readonly status?: LessonStatus;
  readonly role?: LessonRole;
  readonly limit?: number;
}

export interface LessonRankingInput {
  /** Omit to inject role-agnostic lessons only. */
  readonly role?: LessonRole;
  readonly languages?: readonly string[];
  readonly query?: string;
  readonly topN: number;
}

export type LessonTextValidation =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

/**
 * A deliberately small imperative vocabulary. The specification asks for an
 * actionable imperative sentence, so rejecting declarative prose here produces
 * a useful correction instead of storing a lesson that cannot guide an agent.
 */
const IMPERATIVE_OPENERS = new Set([
  "add",
  "adopt",
  "always",
  "apply",
  "ask",
  "avoid",
  "build",
  "call",
  "capture",
  "check",
  "commit",
  "configure",
  "confirm",
  "consider",
  "create",
  "do",
  "document",
  "dont",
  "ensure",
  "escalate",
  "fix",
  "follow",
  "include",
  "keep",
  "limit",
  "log",
  "make",
  "move",
  "never",
  "open",
  "pass",
  "plan",
  "prefer",
  "preserve",
  "propose",
  "read",
  "record",
  "refactor",
  "remove",
  "report",
  "require",
  "review",
  "run",
  "save",
  "share",
  "simplify",
  "skip",
  "split",
  "start",
  "stop",
  "test",
  "treat",
  "update",
  "use",
  "validate",
  "verify",
  "wait",
  "write",
]);

export function isLessonRole(value: unknown): value is LessonRole {
  return value === "*" || isRoleId(value);
}

export function isLessonStatus(value: unknown): value is LessonStatus {
  return typeof value === "string" && (LESSON_STATUSES as readonly string[]).includes(value);
}

export function validateLessonText(raw: string): LessonTextValidation {
  if (/[\r\n]/.test(raw)) {
    return { ok: false, message: "Lesson text must be a single line." };
  }

  const text = raw.replace(/[ \t]+/g, " ").trim();
  const length = [...text].length;
  if (length < MIN_LESSON_CHARS) {
    return {
      ok: false,
      message: `Lesson text must be at least ${MIN_LESSON_CHARS} characters.`,
    };
  }
  if (length > MAX_LESSON_CHARS) {
    return {
      ok: false,
      message: `Lesson text must be at most ${MAX_LESSON_CHARS} characters.`,
    };
  }
  if (text.endsWith("?")) {
    return {
      ok: false,
      message: "Lesson text must be an actionable sentence, not a question.",
    };
  }

  const opener = text
    .match(/^[A-Za-z]+(?:['’][A-Za-z]+)?/)?.[0]
    .toLowerCase()
    .replace(/['’]/g, "");
  if (!opener || !IMPERATIVE_OPENERS.has(opener)) {
    return {
      ok: false,
      message: "Lesson text must start with an imperative verb such as Use, Run, Keep, or Verify.",
    };
  }

  return { ok: true, text };
}

export function normalizeLessonStack(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase() || "*";
  if (normalized === "*") return "*";
  return /^[a-z0-9][a-z0-9+#._-]{0,31}$/.test(normalized) ? normalized : undefined;
}

export function lessonTokens(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9+#]+/g) ?? [];
  return [...new Set(matches.filter((token) => token.length >= 2 && !STOP_WORDS.has(token)))];
}

export function lessonSimilarity(left: string, right: string): number {
  const leftTokens = new Set(lessonTokens(left));
  const rightTokens = new Set(lessonTokens(right));
  if (leftTokens.size === 0 && rightTokens.size === 0) {
    return left.trim().toLowerCase() === right.trim().toLowerCase() ? 1 : 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class LessonsRepository {
  constructor(
    private readonly db: TeamDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  countOpen(): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lessons WHERE status = 'proposed'",
    );
    return row ? Number(row.count) : 0;
  }

  countForRun(runId: string): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lessons WHERE source_run = ?",
      [runId],
    );
    return row ? Number(row.count) : 0;
  }

  get(id: number): LessonRow | undefined {
    return this.db.get<LessonRow>("SELECT * FROM lessons WHERE id = ?", [id]);
  }

  list(filter: LessonListFilter = {}): LessonRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.role) {
      clauses.push("role = ?");
      params.push(filter.role);
    }
    const limit = filter.limit === undefined
      ? ""
      : ` LIMIT ${Math.max(1, Math.floor(filter.limit))}`;
    return this.db.all<LessonRow>(
      `SELECT * FROM lessons${clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id${limit}`,
      params,
    );
  }

  findDuplicate(role: LessonRole, text: string): LessonRow | undefined {
    const candidates = this.duplicateCandidates(role, text);
    let best: LessonRow | undefined;
    let bestScore = 0;
    for (const row of candidates) {
      const score = lessonSimilarity(text, row.text);
      if (score < DUPLICATE_SIMILARITY_THRESHOLD) continue;
      if (score > bestScore || (score === bestScore && (!best || row.id < best.id))) {
        best = row;
        bestScore = score;
      }
    }
    return best;
  }

  insert(input: InsertLessonInput): number {
    const result = this.db.run(
      `INSERT INTO lessons
        (role, text, evidence, source_run, stack_tag, status, hit_count, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, 'proposed', 0, ?, NULL)`,
      [
        input.role,
        input.text,
        input.evidence ?? null,
        input.sourceRun ?? null,
        input.stackTag,
        this.now(),
      ],
    );
    return Number(result.lastInsertRowid);
  }

  setStatus(id: number, status: LessonStatus, decidedAt: string = this.now()): LessonRow | undefined {
    this.db.run(
      "UPDATE lessons SET status = ?, decided_at = ? WHERE id = ?",
      [status, decidedAt, id],
    );
    return this.get(id);
  }

  /**
   * Return at most `topN` approved lessons for a request. FTS/BM25 matches come
   * first; the recency/hit-count fallback fills any remaining slots. Every
   * ordering ends with the lesson id so repeated requests are deterministic.
   */
  rankApproved(input: LessonRankingInput): LessonRow[] {
    const limit = Number.isFinite(input.topN) ? Math.max(1, Math.floor(input.topN)) : 1;
    const scope = approvedScope(input.role, input.languages ?? []);
    const ranked: LessonRow[] = [];
    const seen = new Set<number>();

    const queryTokens = lessonTokens(input.query ?? "").slice(0, 40);
    if (queryTokens.length > 0) {
      const match = queryTokens.map((token) => `"${token.replace(/\"/g, "")}"`).join(" OR ");
      try {
        const rows = this.db.all<LessonRow>(
          `SELECT lessons.* FROM lessons_fts
           JOIN lessons ON lessons.id = lessons_fts.rowid
           WHERE lessons_fts MATCH ? AND ${scope.clauses.join(" AND ")}
           ORDER BY bm25(lessons_fts), lessons.id
           LIMIT ?`,
          [match, ...scope.params, limit],
        );
        for (const row of rows) {
          ranked.push(row);
          seen.add(row.id);
        }
      } catch {
        // A malformed or unavailable FTS index falls back to recency and hits.
      }
    }

    if (ranked.length < limit) {
      const rows = this.db.all<LessonRow>(
        `SELECT lessons.* FROM lessons
         WHERE ${scope.clauses.join(" AND ")}
         ORDER BY lessons.hit_count DESC, lessons.created_at DESC, lessons.id
         LIMIT ?`,
        [...scope.params, limit],
      );
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        ranked.push(row);
        seen.add(row.id);
        if (ranked.length >= limit) break;
      }
    }

    return ranked.slice(0, limit);
  }

  recordHits(ids: readonly number[]): void {
    const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (unique.length === 0) return;
    this.db.run(
      `UPDATE lessons SET hit_count = hit_count + 1 WHERE id IN (${unique.map(() => "?").join(", ")})`,
      unique,
    );
  }

  private duplicateCandidates(role: LessonRole, text: string): LessonRow[] {
    const fallback = (): LessonRow[] => this.db.all<LessonRow>(
      "SELECT * FROM lessons WHERE role = ? AND status <> 'rejected' ORDER BY id LIMIT 200",
      [role],
    );
    const tokens = lessonTokens(text).slice(0, 40);
    if (tokens.length === 0) return fallback();

    const match = tokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" OR ");
    try {
      return this.db.all<LessonRow>(
        `SELECT lessons.* FROM lessons_fts
         JOIN lessons ON lessons.id = lessons_fts.rowid
         WHERE lessons_fts MATCH ? AND lessons.role = ? AND lessons.status <> 'rejected'
         ORDER BY bm25(lessons_fts), lessons.id
         LIMIT 25`,
        [match, role],
      );
    } catch {
      return fallback();
    }
  }
}

function approvedScope(
  role: LessonRole | undefined,
  languages: readonly string[],
): { readonly clauses: readonly string[]; readonly params: readonly string[] } {
  const clauses = ["lessons.status = 'approved'"];
  const params: string[] = [];

  if (role) {
    clauses.push("lessons.role IN (?, '*')");
    params.push(role);
  } else {
    clauses.push("lessons.role = '*'");
  }

  const normalized = [...new Set(
    languages.map((language) => language.trim().toLowerCase()).filter(Boolean),
  )];
  if (normalized.length > 0) {
    clauses.push(`(lessons.stack_tag = '*' OR lessons.stack_tag IN (${normalized.map(() => "?").join(", ")}))`);
    params.push(...normalized);
  } else {
    clauses.push("lessons.stack_tag = '*'");
  }

  return { clauses, params };
}
