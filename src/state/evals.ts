import type { TeamDatabase } from "./db";

export interface EvalRunRow {
  readonly id: number;
  readonly task: string;
  readonly prompt_set_sha: string | null;
  readonly model_set_sha: string | null;
  readonly stack: string | null;
  readonly started_at: string;
  readonly score: number | null;
  readonly details_json: string | null;
}

export interface NewEvalRun {
  readonly task: string;
  readonly promptSetSha?: string | null;
  readonly modelSetSha?: string | null;
  readonly stack?: string | null;
  readonly startedAt?: string;
  readonly score?: number | null;
  readonly detailsJson?: string | null;
}

export interface EvalRunFilter {
  readonly task?: string;
  readonly promptSetSha?: string;
  readonly modelSetSha?: string;
}

export class EvalRepository {
  constructor(
    private readonly db: TeamDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  insert(input: NewEvalRun): EvalRunRow {
    const result = this.db.run(
      `INSERT INTO eval_runs
        (task, prompt_set_sha, model_set_sha, stack, started_at, score, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.task,
        input.promptSetSha ?? null,
        input.modelSetSha ?? null,
        input.stack ?? null,
        input.startedAt ?? this.now(),
        input.score ?? null,
        input.detailsJson ?? null,
      ],
    );
    const row = this.get(Number(result.lastInsertRowid));
    if (!row) throw new Error("Evaluation run was inserted but could not be read back.");
    return row;
  }

  get(id: number): EvalRunRow | undefined {
    return this.db.get<EvalRunRow>("SELECT * FROM eval_runs WHERE id = ?", [id]);
  }

  list(filter: EvalRunFilter = {}): EvalRunRow[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.task !== undefined) {
      clauses.push("task = ?");
      params.push(filter.task);
    }
    if (filter.promptSetSha !== undefined) {
      clauses.push("prompt_set_sha = ?");
      params.push(filter.promptSetSha);
    }
    if (filter.modelSetSha !== undefined) {
      clauses.push("model_set_sha = ?");
      params.push(filter.modelSetSha);
    }
    return this.db.all<EvalRunRow>(
      `SELECT * FROM eval_runs${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY started_at, id`,
      params,
    );
  }
}
