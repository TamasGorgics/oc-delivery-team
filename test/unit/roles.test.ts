import { describe, expect, test } from "bun:test";
import { PHASE_OWNERS } from "../../src/state/phases";
import {
  enabledRoles,
  ROLE_BY_ID,
  ROLE_COLORS,
  ROLE_IDS,
  ROLES,
  rolePermissionRules,
  type RoleId,
} from "../../src/roles";

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
    expect(ROLE_BY_ID.researcher).toMatchObject({ tier: "fast", maxSteps: 40, artifacts: ["brainstorm.md"] });
    expect(ROLE_BY_ID.spec).toMatchObject({ tier: "reasoning", maxSteps: 40, artifacts: ["spec.md", "plan.md"] });
    expect(ROLE_BY_ID.developer).toMatchObject({ tier: "coding", maxSteps: 80, writesSource: true });
    expect(ROLE_BY_ID.tester).toMatchObject({ tier: "coding", maxSteps: 50, writeScope: "tests" });
    expect(ROLE_BY_ID.qa).toMatchObject({ tier: "coding", maxSteps: 40, readOnly: false });
    expect(ROLE_BY_ID.adversary).toMatchObject({ tier: "reasoning", maxSteps: 60 });
    expect(ROLE_BY_ID.docs).toMatchObject({ tier: "fast", maxSteps: 40, writeScope: "docs" });
    expect(ROLE_BY_ID.retro).toMatchObject({ tier: "reasoning", maxSteps: 40, writeScope: "root" });
    expect(ROLE_IDS.every((id) => ROLE_BY_ID[id].promptId === id)).toBe(true);
    expect(ROLE_IDS.every((id) => ROLE_BY_ID[id].toolNeeds.length > 0)).toBe(true);
  });

  test("gives every role a distinct six-digit hex color", () => {
    const expected: Record<RoleId, string> = {
      "team-lead": "#8B5CF6",
      researcher: "#0EA5E9",
      spec: "#2563EB",
      developer: "#16A34A",
      tester: "#CA8A04",
      qa: "#DB2777",
      adversary: "#DC2626",
      docs: "#0D9488",
      retro: "#EA580C",
    };

    expect(ROLE_COLORS).toEqual(expected);
    for (const id of ROLE_IDS) {
      const color = ROLE_BY_ID[id].color;
      expect(color).toBe(expected[id]);
      expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    expect(new Set(ROLES.map((role) => role.color)).size).toBe(ROLE_IDS.length);
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
      { action: "edit", resource: ".team/**", effect: "allow" },
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
