import type { EvalRunRow } from "../state/evals";

export type EvalReportDimension = "both" | "prompt_set_sha" | "model_set_sha";

export interface EvalReportGroup {
  readonly key: string;
  readonly count: number;
  readonly mean_score: number | null;
  readonly mean_loops: number | null;
  readonly mean_cost: number | null;
  readonly prompt_set_shas: readonly string[];
  readonly model_set_shas: readonly string[];
  readonly statuses: Readonly<Record<string, number>>;
  readonly tasks: readonly {
    readonly task: string;
    readonly score: number | null;
    readonly status: string;
    readonly prompt_set_sha: string | null;
    readonly model_set_sha: string | null;
  }[];
}

interface Details {
  readonly status?: unknown;
  readonly run?: {
    readonly loops?: unknown;
    readonly cost?: unknown;
  } | null;
}

export function buildEvalReport(
  rows: readonly EvalRunRow[],
  dimension: EvalReportDimension = "both",
): EvalReportGroup[] {
  const groups = new Map<string, {
    scores: number[];
    loops: number[];
    costs: number[];
    promptShas: Set<string>;
    modelShas: Set<string>;
    statuses: Map<string, number>;
    tasks: EvalReportGroup["tasks"][number][];
  }>();

  for (const row of rows) {
    const details = parseDetails(row.details_json);
    const status = typeof details.status === "string" ? details.status : "unknown";
    const promptSha = row.prompt_set_sha;
    const modelSha = row.model_set_sha;
    const key = dimension === "prompt_set_sha"
      ? promptSha ?? "(none)"
      : dimension === "model_set_sha"
        ? modelSha ?? "(none)"
        : `${promptSha ?? "(none)"} / ${modelSha ?? "(none)"}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        scores: [],
        loops: [],
        costs: [],
        promptShas: new Set(),
        modelShas: new Set(),
        statuses: new Map(),
        tasks: [],
      };
      groups.set(key, group);
    }
    if (promptSha) group.promptShas.add(promptSha);
    if (modelSha) group.modelShas.add(modelSha);
    if (typeof row.score === "number" && Number.isFinite(row.score)) group.scores.push(row.score);
    if (typeof details.run?.loops === "number" && Number.isFinite(details.run.loops)) {
      group.loops.push(details.run.loops);
    }
    if (typeof details.run?.cost === "number" && Number.isFinite(details.run.cost)) {
      group.costs.push(details.run.cost);
    }
    group.statuses.set(status, (group.statuses.get(status) ?? 0) + 1);
    group.tasks.push({
      task: row.task,
      score: row.score,
      status,
      prompt_set_sha: promptSha,
      model_set_sha: modelSha,
    });
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => ({
      key,
      count: group.tasks.length,
      mean_score: mean(group.scores),
      mean_loops: mean(group.loops),
      mean_cost: mean(group.costs),
      prompt_set_shas: [...group.promptShas].sort(),
      model_set_shas: [...group.modelShas].sort(),
      statuses: Object.fromEntries([...group.statuses.entries()].sort(([left], [right]) => left.localeCompare(right))),
      tasks: [...group.tasks].sort((left, right) => left.task.localeCompare(right.task)),
    }));
}

function parseDetails(raw: string | null): Details {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return value as Details;
  } catch {
    return {};
  }
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return Math.round((total / values.length) * 100) / 100;
}
