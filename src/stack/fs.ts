import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DetectionInput } from "./detect";

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".team",
  "node_modules",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "coverage",
  "vendor",
  ".gradle",
  ".idea",
  ".vscode",
]);

const MAX_FILES = 10_000;
const MAX_DEPTH = 8;
const MAX_READ_BYTES = 256 * 1024;

export function createDetectionInput(projectDir: string): DetectionInput {
  const files = listFiles(projectDir);
  return {
    files,
    readFile(relativePath) {
      try {
        const absolute = path.join(projectDir, relativePath);
        const stats = statSync(absolute);
        if (!stats.isFile() || stats.size > MAX_READ_BYTES) return undefined;
        return readFileSync(absolute, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

export function listFiles(projectDir: string): string[] {
  const result: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (result.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") && entry.name !== ".github" && entry.name !== ".gitlab-ci.yml" && entry.name !== ".circleci") {
        // Keep source-control/CI markers, skip caches and editor state.
        if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(path.join(directory, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const relative = path.relative(projectDir, path.join(directory, entry.name)).split(path.sep).join("/");
        result.push(relative);
      }
    }
  };

  walk(projectDir, 0);
  return result.sort();
}
