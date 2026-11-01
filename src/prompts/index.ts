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
import { withCodeModeGuidance } from "./code-mode";

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

export function getDefaultPrompt(role: RoleId): string {
  return withCodeModeGuidance(DEFAULT_PROMPTS[role]);
}
