import { parsePromptProposalFilename } from "../prompts/proposals";

type DiffOperation =
  | { readonly type: "equal"; readonly line: string }
  | { readonly type: "delete"; readonly line: string }
  | { readonly type: "insert"; readonly line: string };

interface HunkRange {
  start: number;
  end: number;
}

export function promptProposalPathFromArgument(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let filename = value.trim();
  if (filename.startsWith("proposals/")) filename = filename.slice("proposals/".length);
  if (filename.includes("/") || filename.includes("\\") || filename === "" || filename === "..") {
    return undefined;
  }
  if (!filename.endsWith(".md")) filename += ".md";
  return parsePromptProposalFilename(filename)?.relativePath;
}

export function renderPromptDiff(
  current: string,
  proposal: string,
  currentLabel: string,
  proposalLabel: string,
): string {
  const before = splitLines(current);
  const after = splitLines(proposal);
  const operations = buildDiffOperations(before, after);
  const lines = [`--- ${currentLabel}`, `+++ ${proposalLabel}`];
  if (!operations.some((operation) => operation.type !== "equal")) {
    lines.push("No differences.");
    return `${lines.join("\n")}\n`;
  }

  for (const range of hunkRanges(operations, 3)) {
    const hunk = operations.slice(range.start, range.end);
    const oldBefore = countLines(operations.slice(0, range.start), "old");
    const newBefore = countLines(operations.slice(0, range.start), "new");
    const oldCount = countLines(hunk, "old");
    const newCount = countLines(hunk, "new");
    lines.push(
      `@@ -${lineStart(oldBefore, oldCount)},${oldCount} +${lineStart(newBefore, newCount)},${newCount} @@`,
    );
    for (const operation of hunk) {
      const prefix = operation.type === "equal" ? " " : operation.type === "delete" ? "-" : "+";
      lines.push(`${prefix}${operation.line}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function splitLines(value: string): string[] {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function buildDiffOperations(before: readonly string[], after: readonly string[]): DiffOperation[] {
  const rows = before.length + 1;
  const columns = after.length + 1;
  if (before.length * after.length > 1_000_000 || before.length + after.length > 20_000) {
    return [
      ...before.map((line): DiffOperation => ({ type: "delete", line })),
      ...after.map((line): DiffOperation => ({ type: "insert", line })),
    ];
  }

  const common = Array.from({ length: rows }, () => new Uint32Array(columns));
  for (let left = before.length - 1; left >= 0; left -= 1) {
    const row = common[left];
    const nextRow = common[left + 1];
    if (!row || !nextRow) continue;
    for (let right = after.length - 1; right >= 0; right -= 1) {
      row[right] = before[left] === after[right]
        ? 1 + (nextRow[right + 1] ?? 0)
        : Math.max(nextRow[right] ?? 0, row[right + 1] ?? 0);
    }
  }

  const operations: DiffOperation[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      operations.push({ type: "equal", line: before[left] ?? "" });
      left += 1;
      right += 1;
    } else if (
      left < before.length
      && (right >= after.length || (common[left + 1]?.[right] ?? 0) >= (common[left]?.[right + 1] ?? 0))
    ) {
      operations.push({ type: "delete", line: before[left] ?? "" });
      left += 1;
    } else {
      operations.push({ type: "insert", line: after[right] ?? "" });
      right += 1;
    }
  }
  return operations;
}

function hunkRanges(operations: readonly DiffOperation[], context: number): HunkRange[] {
  const ranges: HunkRange[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index]?.type === "equal") continue;
    const start = Math.max(0, index - context);
    const end = Math.min(operations.length, index + context + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = end;
    else ranges.push({ start, end });
  }
  return ranges;
}

function countLines(operations: readonly DiffOperation[], side: "old" | "new"): number {
  return operations.filter((operation) => side === "old"
    ? operation.type !== "insert"
    : operation.type !== "delete").length;
}

function lineStart(linesBefore: number, lineCount: number): number {
  return lineCount === 0 ? linesBefore : linesBefore + 1;
}
