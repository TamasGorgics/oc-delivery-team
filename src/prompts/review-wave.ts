import type { RoleId } from "../roles";

export const REVIEW_WAVE_HEADING = "## Parallel review wave (enabled)";

/**
 * Conditional guidance appended to the effective prompt only when
 * `reviews.parallel` is enabled. Keep the text stack-neutral: it must not name
 * a toolchain, package manager, or model.
 */
export const REVIEW_WAVE_GUIDANCE: Partial<Record<RoleId, string>> = {
  "team-lead": [
    "- After `test` passes, dispatch `qa` and `adversary` in the same turn; do not call `team_advance` between them.",
    "- Pass each reviewer the run id, goal, exact `artifact_dir`, and prior artifact paths. QA owns `qa.md`; adversary owns `adversary.md`.",
    "- Poll `team_status.review_wave.ready`. Retry only the failing member with `team_loop(role=...)`.",
    "- If the host serializes sessions or a reviewer fails to start, run the missing reviewer sequentially in the same `qa` phase.",
    "- Call `team_advance` only when `review_wave.ready` is true; it moves `qa -> docs`. Never use the `adversary` phase while enabled and never rewind to `adversary`.",
    "- On `ESCALATE_TO_HUMAN`, stop and ask the human.",
  ].join("\n"),
  qa: [
    "- You own only `qa.md`; `adversary` may run concurrently.",
    "- Do not read or write `adversary.md`, and do not call `team_advance`.",
    "- Finish with `VERDICT: PASS|FAIL` and use `team_status.review_wave` to confirm your membership in the wave.",
    "- Call `team_loop` normally; your `qa` identity infers the role.",
  ].join("\n"),
  adversary: [
    "- You own only `adversary.md`; run independently of QA.",
    "- Do not wait for or edit `qa.md`.",
    "- Finish with an integer `BLOCKERS: 0` and list non-blocking findings too.",
    "- Never claim the wave passed; call `team_loop` normally and your `adversary` identity infers the role.",
  ].join("\n"),
  docs: [
    "- Start only after the review barrier passes.",
    "- Read both `qa.md` and `adversary.md`, including non-blocking findings.",
    "- Do not write review artifacts.",
    "- Confirm `team_status` shows the run moved `qa -> docs`.",
  ].join("\n"),
};

/**
 * Append the conditional section exactly once. Omitted/disabled options and
 * roles without guidance return the prompt unchanged.
 */
export function withReviewWaveGuidance(prompt: string, role: RoleId, enabled: boolean): string {
  if (!enabled) return prompt;
  const guidance = REVIEW_WAVE_GUIDANCE[role];
  if (!guidance) return prompt;
  if (prompt.includes(REVIEW_WAVE_HEADING)) return prompt;
  return `${prompt}\n\n${REVIEW_WAVE_HEADING}\n${guidance}`;
}
