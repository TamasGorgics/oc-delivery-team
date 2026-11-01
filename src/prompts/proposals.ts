import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";
import { ROLE_IDS, type RoleId } from "../roles";
import { PromptRepository, type PromptVersionRow } from "../state/prompts";

const PROPOSAL_DIRECTORY = "proposals";
const SAFE_TIMESTAMP = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export interface PromptProposalFile {
  readonly role: RoleId;
  readonly timestamp: string;
  readonly filename: string;
  readonly relativePath: string;
}

export interface PromptProposalScanResult {
  readonly directory: string;
  readonly registered: readonly PromptVersionRow[];
  readonly skipped: number;
}

export interface PromptProposalScanOptions {
  readonly sourceRun?: string;
}

export function parsePromptProposalFilename(filename: string): PromptProposalFile | undefined {
  if (path.basename(filename) !== filename || !filename.endsWith(".md")) return undefined;
  for (const role of ROLE_IDS) {
    const prefix = `${role}.`;
    if (!filename.startsWith(prefix)) continue;
    const timestamp = filename.slice(prefix.length, -3);
    if (!SAFE_TIMESTAMP.test(timestamp)) return undefined;
    return {
      role,
      timestamp,
      filename,
      relativePath: path.posix.join(PROPOSAL_DIRECTORY, filename),
    };
  }
  return undefined;
}

export function promptProposalSha(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

/** Record role-scoped proposal files without ever loading them as prompts. */
export function scanPromptProposals(
  rootDir: string,
  repository: PromptRepository,
  options: PromptProposalScanOptions = {},
): PromptProposalScanResult {
  const directory = path.join(rootDir, PROPOSAL_DIRECTORY);
  let entries: Dirent<string>[];
  try {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`Prompt proposal path is not a regular directory: ${directory}`);
    }
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return { directory, registered: [], skipped: 0 };
    throw error;
  }

  const registered: PromptVersionRow[] = [];
  let skipped = 0;
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const proposal = parsePromptProposalFilename(entry.name);
    if (!proposal) {
      if (entry.name.endsWith(".md")) skipped += 1;
      continue;
    }
    if (!entry.isFile()) {
      skipped += 1;
      continue;
    }

    const filePath = path.join(directory, proposal.filename);
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      skipped += 1;
      continue;
    }
    const contents = readFileSync(filePath, "utf8");
    const result = repository.recordProposal({
      role: proposal.role,
      sha: promptProposalSha(contents),
      path: proposal.relativePath,
      ...(options.sourceRun ? { sourceRun: options.sourceRun } : {}),
      createdAt: stat.mtime.toISOString(),
    });
    if (result.inserted) registered.push(result.row);
  }

  return { directory, registered, skipped };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
