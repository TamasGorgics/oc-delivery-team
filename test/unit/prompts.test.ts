import { describe, expect, test } from "bun:test";
import { DEFAULT_PROMPTS, getDefaultPrompt } from "../../src/prompts";
import { ROLE_IDS } from "../../src/roles";

const STACK_DENYLIST = [
  /\bnpm\s+/i,
  /\bpytest\b/i,
  /\bgo\s+test\b/i,
  /\bcargo\b/i,
  /\bmvn\b/i,
  /\bgradle\b/i,
  /\bdotnet\b/i,
];

describe("built-in role prompts", () => {
  test("provides a single stack-neutral prompt for each role", () => {
    expect(Object.keys(DEFAULT_PROMPTS).sort()).toEqual([...ROLE_IDS].sort());
    for (const prompt of Object.values(DEFAULT_PROMPTS)) {
      expect(prompt).toContain("team_note");
      expect(prompt).toContain("team_loop");
      expect(prompt.toLowerCase()).toContain("pass paths, not content");
      expect(prompt.toLowerCase()).toContain("stay within your scope");
      expect(prompt).toContain("Stack Profile");
    }
  });

  test("names the role artifact and required footer for gated artifacts", () => {
    expect(DEFAULT_PROMPTS.researcher).toContain("brainstorm.md");
    expect(DEFAULT_PROMPTS.spec).toContain("spec.md");
    expect(DEFAULT_PROMPTS.spec).toContain("plan.md");
    expect(DEFAULT_PROMPTS.spec).toContain("Create both artifacts early");
    expect(DEFAULT_PROMPTS.spec).toContain("Do not spend the full step budget");
    expect(DEFAULT_PROMPTS.spec).toContain("STATUS: DRAFT");
    expect(DEFAULT_PROMPTS.developer).toContain("impl-notes.md");
    expect(DEFAULT_PROMPTS.tester).toContain("test-report.md");
    expect(DEFAULT_PROMPTS.tester).toContain("RESULT: PASS");
    expect(DEFAULT_PROMPTS.tester).toContain("EXIT: 0");
    expect(DEFAULT_PROMPTS.qa).toContain("VERDICT: PASS");
    expect(DEFAULT_PROMPTS.adversary).toContain("BLOCKERS: 0");
    expect(DEFAULT_PROMPTS.docs).toContain("docs.md");
    expect(DEFAULT_PROMPTS.retro).toContain("retro.md");
    expect(DEFAULT_PROMPTS.retro).toContain("team_lesson_propose");
    expect(DEFAULT_PROMPTS.retro).toContain("proposals/<role>.<timestamp>.md");
    expect(DEFAULT_PROMPTS.retro).not.toContain("Do not propose");
    expect(DEFAULT_PROMPTS["team-lead"]).toContain("brainstorm -> spec -> plan -> implement -> test -> qa -> adversary -> docs -> retro -> done");
    expect(DEFAULT_PROMPTS["team-lead"]).toContain("ask the human");
    expect(DEFAULT_PROMPTS["team-lead"]).toContain("team_worktree");
    expect(DEFAULT_PROMPTS["team-lead"]).toContain("exact `artifact_dir`");
    expect(DEFAULT_PROMPTS["team-lead"]).toContain("never ask a different role to persist another role's artifact");
    expect(DEFAULT_PROMPTS["team-lead"]).toContain("If a subagent reaches its step limit");
    expect(DEFAULT_PROMPTS["team-lead"]).toContain("do not use another role as a scribe");
    expect(DEFAULT_PROMPTS["team-lead"]).toContain("spec and plan -> spec");
    expect(DEFAULT_PROMPTS["team-lead"]).toContain("built-in read-only plan agent");
    expect(DEFAULT_PROMPTS.spec).toContain("You own both the spec and plan phases");
    expect(DEFAULT_PROMPTS.developer).toContain("unique short name");
  });

  test("adds Code Mode and artifact-path guidance to every effective prompt", () => {
    for (const role of ROLE_IDS) {
      expect(getDefaultPrompt(role)).toContain("## Code Mode runtime");
      expect(getDefaultPrompt(role)).toContain("tools.team_*");
      expect(getDefaultPrompt(role)).toContain("Do not use `import()`");
      expect(getDefaultPrompt(role)).toContain("## Artifact paths");
      expect(getDefaultPrompt(role)).toContain("<artifact_dir>/brainstorm.md");
    }
  });

  test("contains no unlabeled stack-specific command examples", () => {
    const promptText = Object.values(DEFAULT_PROMPTS)
      .map(removeLabeledExampleBlocks)
      .join("\n");
    for (const pattern of STACK_DENYLIST) expect(promptText).not.toMatch(pattern);
  });
});

function removeLabeledExampleBlocks(prompt: string): string {
  return prompt.replace(/```([^\n]*)\n[\s\S]*?```/g, (block, header: string) => (
    /example/i.test(header) ? "" : block
  ));
}
