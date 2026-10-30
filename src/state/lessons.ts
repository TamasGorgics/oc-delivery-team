import type { TeamDatabase } from "./db";

export type LessonStatus = "proposed" | "approved" | "retired" | "rejected";

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

/**
 * M2 only needs lesson counts for team_status. Proposal, approval, ranking, and
 * injection arrive in M5.
 */
export class LessonsRepository {
  constructor(private readonly db: TeamDatabase) {}

  countOpen(): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lessons WHERE status = 'proposed'",
    );
    return row ? Number(row.count) : 0;
  }

  get(id: number): LessonRow | undefined {
    return this.db.get<LessonRow>("SELECT * FROM lessons WHERE id = ?", [id]);
  }
}
