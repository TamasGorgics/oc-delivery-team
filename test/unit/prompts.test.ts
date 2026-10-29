import { describe, expect, test } from "bun:test";
import { DEFAULT_PROMPTS } from "../../src/prompts";
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
    expect(DEFAULT_PROMPTS.spec).toContain("STATUS: DRAFT");
    expect(DEFAULT_PROMPTS.developer).toContain("impl-notes.md");
    expect(DEFAULT_PROMPTS.tester).toContain("test-report.md");
    expect(DEFAULT_PROMPTS.tester).toContain("RESULT: PASS");
    expect(DEFAULT_PROMPTS.tester).toContain("EXIT: 0");
    expect(DEFAULT_PROMPTS.qa).toContain("VERDICT: PASS");
    expect(DEFAULT_PROMPTS.adversary).toContain("BLOCKERS: 0");
    expect(DEFAULT_PROMPTS.docs).toContain("docs.md");
    expect(DEFAULT_PROMPTS.retro).toContain("retro.md");
    expect(DEFAULT_PROMPTS["team-lead"]).toContain("brainstorm -> spec -> plan -> implement -> test -> qa -> adversary -> docs -> retro -> done");
    expect(DEFAULT_PROMPTS["team-lead"]).toContain("ask the human");
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
