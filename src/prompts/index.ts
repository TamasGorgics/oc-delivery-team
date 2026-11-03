import adversary from "./adversary";
import developer from "./developer";
import docs from "./docs";
import qa from "./qa";
import researcher from "./researcher";
import retro from "./retro";
import spec from "./spec";
import teamLead from "./team-lead";
import tester from "./tester";
import type { RoleId } from "../roles";
import { withArtifactPathGuidance } from "./artifact-path";
import { withCodeModeGuidance } from "./code-mode";
import { withReviewWaveGuidance } from "./review-wave";

export const DEFAULT_PROMPTS: Readonly<Record<RoleId, string>> = {
  "team-lead": teamLead,
  researcher,
  spec,
  developer,
  tester,
  qa,
  adversary,
  docs,
  retro,
};

export function withRuntimeGuidance(prompt: string): string {
  return withArtifactPathGuidance(withCodeModeGuidance(prompt));
}

export interface PromptOptions {
  /** Append the conditional parallel-review-wave guidance. */
  readonly reviewWave?: boolean;
}

export function getDefaultPrompt(role: RoleId, options?: PromptOptions): string {
  return withReviewWaveGuidance(
    withRuntimeGuidance(DEFAULT_PROMPTS[role]),
    role,
    options?.reviewWave === true,
  );
}
