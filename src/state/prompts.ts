import type { TeamDatabase } from "./db";

export type PromptVersionStatus = "proposed" | "approved" | "rejected" | "superseded";

export const PROMPT_VERSION_STATUSES = ["proposed", "approved", "rejected", "superseded"] as const;

export interface PromptVersionRow {
  readonly id: number;
  readonly role: string;
  readonly sha: string;
  readonly path: string | null;
  readonly status: PromptVersionStatus;
  readonly source_run: string | null;
  readonly created_at: string;
  readonly decided_at: string | null;
}

export interface PromptVersionFilter {
  readonly role?: string;
  readonly status?: PromptVersionStatus;
}

export interface PromptProposalRecord {
  readonly role: string;
  readonly sha: string;
  /** Root-relative source file, e.g. `proposals/developer.20261031T120000Z.md`. */
  readonly path: string;
  readonly sourceRun?: string;
  readonly createdAt?: string;
}

export function isPromptVersionStatus(value: unknown): value is PromptVersionStatus {
  return typeof value === "string"
    && (PROMPT_VERSION_STATUSES as readonly string[]).includes(value);
}

export class PromptRepository {
  constructor(
    private readonly db: TeamDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(filter: PromptVersionFilter = {}): PromptVersionRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.role !== undefined) {
      clauses.push("role = ?");
      params.push(filter.role);
    }
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    return this.db.all<PromptVersionRow>(
      `SELECT * FROM prompt_versions${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC`,
      params,
    );
  }

  get(id: number): PromptVersionRow | undefined {
    return this.db.get<PromptVersionRow>("SELECT * FROM prompt_versions WHERE id = ?", [id]);
  }

  getByPath(sourcePath: string): PromptVersionRow | undefined {
    return this.db.get<PromptVersionRow>(
      "SELECT * FROM prompt_versions WHERE path = ? ORDER BY id DESC LIMIT 1",
      [sourcePath],
    );
  }

  recordProposal(input: PromptProposalRecord): { readonly row: PromptVersionRow; readonly inserted: boolean } {
    return this.db.transaction(() => {
      const existing = this.getByPath(input.path);
      if (existing) {
        if (existing.status === "proposed"
          && (existing.sha !== input.sha || (!existing.source_run && input.sourceRun))) {
          this.db.run(
            `UPDATE prompt_versions
             SET sha = ?, source_run = COALESCE(source_run, ?)
             WHERE id = ? AND status = 'proposed'`,
            [input.sha, input.sourceRun ?? null, existing.id],
          );
          return { row: this.get(existing.id) ?? existing, inserted: false };
        }
        return { row: existing, inserted: false };
      }

      const result = this.db.run(
        `INSERT INTO prompt_versions (role, sha, path, status, source_run, created_at, decided_at)
         VALUES (?, ?, ?, 'proposed', ?, ?, NULL)`,
        [
          input.role,
          input.sha,
          input.path,
          input.sourceRun ?? null,
          input.createdAt ?? this.now(),
        ],
      );
      const row = this.get(Number(result.lastInsertRowid));
      if (!row) throw new Error("Prompt proposal was inserted but could not be read back.");
      return { row, inserted: true };
    });
  }

  updateProposedSha(id: number, sha: string): void {
    this.db.run(
      "UPDATE prompt_versions SET sha = ? WHERE id = ? AND status = 'proposed'",
      [sha, id],
    );
  }

  setStatus(
    id: number,
    status: PromptVersionStatus,
    decidedAt: string = this.now(),
  ): PromptVersionRow | undefined {
    this.db.run(
      "UPDATE prompt_versions SET status = ?, decided_at = ? WHERE id = ?",
      [status, decidedAt, id],
    );
    return this.get(id);
  }

  setStatusFrom(
    id: number,
    expected: PromptVersionStatus,
    status: PromptVersionStatus,
    decidedAt: string = this.now(),
  ): PromptVersionRow | undefined {
    const result = this.db.run(
      "UPDATE prompt_versions SET status = ?, decided_at = ? WHERE id = ? AND status = ?",
      [status, decidedAt, id, expected],
    );
    return result.changes === 1 ? this.get(id) : undefined;
  }

  supersedeApproved(role: string, decidedAt: string = this.now()): void {
    this.db.run(
      `UPDATE prompt_versions SET status = 'superseded', decided_at = ?
       WHERE role = ? AND status = 'approved'`,
      [decidedAt, role],
    );
  }
}
