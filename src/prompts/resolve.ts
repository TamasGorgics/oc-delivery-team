import { readFileSync } from "node:fs";
import path from "node:path";
import type { RoleId } from "../roles";
import type { PromptRepository } from "../state/prompts";
import { getDefaultPrompt, withRuntimeGuidance } from "./index";
import { promptProposalSha } from "./proposals";

export interface EffectivePrompt {
  readonly role: RoleId;
  readonly text: string;
  readonly source: "builtin" | "approved";
  readonly raw?: string;
  readonly sha?: string;
}

export function resolveRolePrompt(
  rootDir: string,
  role: RoleId,
  prompts: PromptRepository | null,
): EffectivePrompt {
  const defaultPrompt = getDefaultPrompt(role);
  const fallback: EffectivePrompt = { role, text: defaultPrompt, source: "builtin" };
  if (!prompts) return fallback;

  const overridePath = path.join(rootDir, "prompts", `${role}.md`);
  try {
    const raw = readFileSync(overridePath, "utf8");
    const text = raw.trim();
    if (!text) return fallback;
    const sha = promptProposalSha(raw);
    const approved = prompts.list({ role, status: "approved" }).some((version) => version.sha === sha);
    return approved
      ? { role, text: withRuntimeGuidance(text), raw, sha, source: "approved" }
      : fallback;
  } catch {
    return fallback;
  }
}
