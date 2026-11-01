import { describe, expect, test } from "bun:test";
import { PHASE_OWNERS } from "../../src/state/phases";
import { enabledRoles, ROLE_BY_ID, ROLE_IDS, rolePermissionRules } from "../../src/roles";

describe("role definitions", () => {
  test("defines all nine roles and their default modes, tiers, artifacts, and step limits", () => {
    expect(ROLE_IDS).toEqual([
      "team-lead",
      "researcher",
      "spec",
      "developer",
      "tester",
      "qa",
      "adversary",
      "docs",
      "retro",
    ]);
    expect(ROLE_BY_ID["team-lead"].mode).toBe("primary");
    expect(ROLE_BY_ID["team-lead"].maxSteps).toBeUndefined();
    expect(ROLE_BY_ID.researcher).toMatchObject({ tier: "fast", maxSteps: 25, artifacts: ["brainstorm.md"] });
    expect(ROLE_BY_ID.spec).toMatchObject({ tier: "reasoning", maxSteps: 40, artifacts: ["spec.md", "plan.md"] });
    expect(ROLE_BY_ID.developer).toMatchObject({ tier: "coding", maxSteps: 80, writesSource: true });
    expect(ROLE_BY_ID.tester).toMatchObject({ tier: "coding", maxSteps: 50, writeScope: "tests" });
    expect(ROLE_BY_ID.qa).toMatchObject({ tier: "coding", maxSteps: 30, readOnly: false });
    expect(ROLE_BY_ID.adversary).toMatchObject({ tier: "reasoning", maxSteps: 40 });
    expect(ROLE_BY_ID.docs).toMatchObject({ tier: "fast", maxSteps: 20, writeScope: "docs" });
    expect(ROLE_BY_ID.retro).toMatchObject({ tier: "reasoning", maxSteps: 20, writeScope: "root" });
    expect(ROLE_IDS.every((id) => ROLE_BY_ID[id].promptId === id)).toBe(true);
    expect(ROLE_IDS.every((id) => ROLE_BY_ID[id].toolNeeds.length > 0)).toBe(true);
  });

  test("maps every phase to the owning team role", () => {
    expect(PHASE_OWNERS).toMatchObject({
      brainstorm: "researcher",
      spec: "spec",
      plan: "spec",
      implement: "developer",
      test: "tester",
      qa: "qa",
      adversary: "adversary",
      docs: "docs",
      retro: "retro",
      done: null,
    });
    expect(ROLE_IDS).not.toContain("plan");
  });

  test("gives every artifact-writing role a write-capable toolset", () => {
    for (const role of ["researcher", "spec", "developer", "tester", "qa", "adversary", "docs", "retro"] as const) {
      expect(ROLE_BY_ID[role].toolNeeds).toEqual(expect.arrayContaining(["edit", "write", "patch"]));
    }
  });

  test("omits disabled roles without mutating the role table", () => {
    expect(enabledRoles(["docs", "qa"]).map((role) => role.id)).toHaveLength(7);
    expect(enabledRoles().map((role) => role.id)).toEqual([...ROLE_IDS]);
  });

  test("builds coarse M1 write and shell permissions", () => {
    expect(rolePermissionRules(ROLE_BY_ID["team-lead"], "/project/.team")).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ]);
    expect(rolePermissionRules(ROLE_BY_ID.spec, "/project/.team")).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: "/project/.team/**", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
    ]);
    expect(rolePermissionRules(ROLE_BY_ID.developer, "/project/.team")).toEqual([
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
    ]);
    expect(rolePermissionRules(ROLE_BY_ID.docs, "/project/.team")).toEqual([
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
    ]);
  });
});
