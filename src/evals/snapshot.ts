import { createHash } from "node:crypto";
import { ROLE_IDS } from "../roles";
import type { PromptRepository } from "../state/prompts";
import { resolveRolePrompt, type EffectivePrompt } from "../prompts/resolve";

export interface PromptSetSnapshot {
  readonly sha: string;
  readonly prompts: readonly EffectivePrompt[];
}

export function capturePromptSet(rootDir: string, prompts: PromptRepository): PromptSetSnapshot {
  const resolved = [...ROLE_IDS]
    .sort()
    .map((role) => resolveRolePrompt(rootDir, role, prompts));
  const promptMap = Object.fromEntries(resolved.map((prompt) => [prompt.role, prompt.text]));
  return { sha: sha256(canonicalJson(promptMap)), prompts: resolved };
}

export function modelSetSha(snapshot: unknown): string | null {
  if (snapshot === undefined || snapshot === null) return null;
  return sha256(canonicalJson(snapshot));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortRecursively(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortRecursively(item)]),
  );
}
