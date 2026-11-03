import { describe, expect, test } from "bun:test";
import { parseConfig } from "../../src/config";

describe("plugin configuration", () => {
  test("applies SPEC defaults and resolves project-relative paths", () => {
    const config = parseConfig(undefined, "/workspace/project");

    expect(config.root).toBe(".team");
    expect(config.rootDir).toBe("/workspace/project/.team");
    expect(config.dbPath).toBe("/workspace/project/.team/team.db");
    expect(config.maxLoops).toBe(3);
    expect(config.lessons).toEqual({ topN: 8, budgetChars: 4000 });
    expect(config.stack).toEqual({ detect: true, overrides: undefined });
    expect(config.roles.disabled).toEqual([]);
    expect(config.reviews).toEqual({ parallel: true });
    expect(config.gating).toEqual({
      enabled: true,
      strict: false,
      editTools: ["edit", "write", "patch"],
      pathKeys: {},
    });
    expect(config.trace).toEqual({ captureInput: false, previewChars: 0 });
    expect(config.worktrees).toEqual({ enabled: false, baseDir: "../.team-worktrees" });
    expect(config.models).toEqual({
      default: undefined,
      tiers: {},
      roles: {},
      roleTier: {},
      params: {},
      diversity: true,
      auto: false,
    });
    expect(config.warnings).toEqual([]);
  });

  test("normalizes nested options, both model spec forms, and disabled role ids", () => {
    const config = parseConfig({
      root: "./data",
      dbPath: "state/team.sqlite",
      maxLoops: 5,
      lessons: { topN: 4, budgetChars: 2500 },
      stack: { detect: false, overrides: { version: 1 } },
      roles: { disabled: ["docs", "docs", "retro"] },
      gating: { enabled: false, strict: true, editTools: [] },
      trace: { captureInput: true, previewChars: 120 },
      worktrees: { enabled: true, baseDir: "../worktrees" },
      models: {
        default: { model: "provider/default", params: { temperature: 0.2 }, fallback: ["provider/backup"] },
        tiers: { coding: "provider/coding" },
        roles: { developer: { model: "provider/developer", params: { maxSteps: 9 } } },
        roleTier: { docs: "reasoning" },
        params: { tester: { topP: 0.8 } },
        diversity: false,
        auto: true,
      },
    }, "/workspace/project");

    expect(config.rootDir).toBe("/workspace/project/data");
    expect(config.dbPath).toBe("/workspace/project/state/team.sqlite");
    expect(config.maxLoops).toBe(5);
    expect(config.lessons).toEqual({ topN: 4, budgetChars: 2500 });
    expect(config.stack).toEqual({ detect: false, overrides: { version: 1 } });
    expect(config.roles.disabled).toEqual(["docs", "retro"]);
    expect(config.gating).toEqual({ enabled: false, strict: true, editTools: [], pathKeys: {} });
    expect(config.trace).toEqual({ captureInput: true, previewChars: 120 });
    expect(config.worktrees).toEqual({ enabled: true, baseDir: "../worktrees" });
    expect(config.models.default).toEqual({
      model: "provider/default",
      params: { temperature: 0.2 },
      fallback: ["provider/backup"],
    });
    expect(config.models.tiers.coding).toEqual({ model: "provider/coding" });
    expect(config.models.roles.developer).toEqual({ model: "provider/developer", params: { maxSteps: 9 } });
    expect(config.models.roleTier.docs).toBe("reasoning");
    expect(config.models.params.tester).toEqual({ topP: 0.8 });
    expect(config.models.diversity).toBe(false);
    expect(config.models.auto).toBe(true);
    expect(config.warnings).toEqual([]);
  });

  test("accepts configurable edit-tool path keys and warns on invalid entries", () => {
    const config = parseConfig({
      gating: {
        editTools: ["apply"],
        pathKeys: { apply: " target ", empty: "  ", invalid: 7 },
      },
    }, "/workspace/project");

    expect(config.gating.editTools).toEqual(["apply"]);
    expect(config.gating.pathKeys).toEqual({ apply: "target" });
    expect(config.warnings).toContainEqual({
      path: "gating.pathKeys.empty",
      message: "Must be a non-empty string; ignored.",
    });
    expect(config.warnings).toContainEqual({
      path: "gating.pathKeys.invalid",
      message: "Must be a non-empty string; ignored.",
    });
  });

  test("warns and defaults invalid values instead of throwing", () => {
    const config = parseConfig({
      mystery: true,
      maxLoops: 0,
      lessons: { topN: -1, ignored: true },
      roles: { disabled: ["not-a-role", "qa"] },
      models: {
        default: { model: "", unknown: 1 },
        tiers: { strange: "provider/model", fast: null },
        roles: { nope: "provider/model", developer: { model: 7 } },
        roleTier: { qa: "invalid" },
        params: { nope: { temperature: 1 } },
        diversity: "yes",
      },
    }, "/workspace/project");

    expect(config.maxLoops).toBe(3);
    expect(config.lessons.topN).toBe(8);
    expect(config.roles.disabled).toEqual(["qa"]);
    expect(config.models.default).toBeUndefined();
    expect(config.models.tiers.fast).toBeUndefined();
    expect(config.models.roles.developer).toBeUndefined();
    expect(config.models.roleTier.qa).toBeUndefined();
    expect(config.models.params).toEqual({});
    expect(config.models.diversity).toBe(true);
    expect(config.warnings.length).toBeGreaterThan(5);
    expect(config.warnings.some((warning) => warning.path === "mystery")).toBe(true);
    expect(config.warnings.some((warning) => warning.path === "models.tiers.strange")).toBe(true);
    expect(config.warnings.some((warning) => warning.path === "models.roles.developer.model")).toBe(true);
  });

  test("defaults reviews.parallel to true and keeps explicit false as the escape hatch", () => {
    const defaults = parseConfig(undefined, "/workspace/project");
    expect(defaults.reviews).toEqual({ parallel: true });
    expect(defaults.warnings).toEqual([]);

    const enabled = parseConfig({ reviews: { parallel: true } }, "/workspace/project");
    expect(enabled.reviews).toEqual({ parallel: true });
    expect(enabled.warnings).toEqual([]);

    const explicitFalse = parseConfig({ reviews: { parallel: false } }, "/workspace/project");
    expect(explicitFalse.reviews).toEqual({ parallel: false });
    expect(explicitFalse.warnings).toEqual([]);
  });

  test("warns and falls back to the default when reviews.parallel or reviews is invalid", () => {
    const nonBoolean = parseConfig({ reviews: { parallel: "yes" } }, "/workspace/project");
    expect(nonBoolean.reviews).toEqual({ parallel: true });
    expect(nonBoolean.warnings).toContainEqual({
      path: "reviews.parallel",
      message: "Must be a boolean; using default.",
    });

    const nonObject = parseConfig({ reviews: true }, "/workspace/project");
    expect(nonObject.reviews).toEqual({ parallel: true });
    expect(nonObject.warnings).toContainEqual({
      path: "reviews",
      message: "Must be an object; using defaults.",
    });

    const unknown = parseConfig({ reviews: { bogus: true } }, "/workspace/project");
    expect(unknown.reviews).toEqual({ parallel: true });
    expect(unknown.warnings).toContainEqual({
      path: "reviews.bogus",
      message: "Unknown option; ignored.",
    });
  });

  test("effectively disables the review wave when a required review role is disabled", () => {
    const explicitTrue = parseConfig({
      maxLoops: 5,
      roles: { disabled: ["adversary"] },
      reviews: { parallel: true },
    }, "/workspace/project");

    expect(explicitTrue.reviews).toEqual({ parallel: false });
    expect(explicitTrue.maxLoops).toBe(5);
    const warnings = explicitTrue.warnings.filter((warning) => warning.path === "reviews.parallel");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("adversary");
    expect(warnings[0]?.message).toContain("disabled");
    expect(warnings[0]?.message).toContain("reviews.parallel=false");

    const defaulted = parseConfig({ roles: { disabled: ["adversary"] } }, "/workspace/project");
    expect(defaulted.reviews).toEqual({ parallel: false });
    const defaultWarnings = defaulted.warnings.filter((warning) => warning.path === "reviews.parallel");
    expect(defaultWarnings).toHaveLength(1);
    expect(defaultWarnings[0]?.message).toContain("adversary");
    expect(defaultWarnings[0]?.message).toContain("reviews.parallel=false");

    const qaDisabled = parseConfig({
      roles: { disabled: ["qa"] },
      reviews: { parallel: true },
    }, "/workspace/project");
    expect(qaDisabled.reviews).toEqual({ parallel: false });
    const qaWarnings = qaDisabled.warnings.filter((warning) => warning.path === "reviews.parallel");
    expect(qaWarnings).toHaveLength(1);
    expect(qaWarnings[0]?.message).toContain("qa");
    expect(qaWarnings[0]?.message).toContain("disabled");
    expect(qaWarnings[0]?.message).toContain("reviews.parallel=false");

    const bothDisabled = parseConfig({
      roles: { disabled: ["qa", "adversary"] },
      reviews: { parallel: true },
    }, "/workspace/project");
    expect(bothDisabled.reviews).toEqual({ parallel: false });
    const bothWarnings = bothDisabled.warnings.filter((warning) => warning.path === "reviews.parallel");
    expect(bothWarnings).toHaveLength(1);
    expect(bothWarnings[0]?.message).toContain("qa");
    expect(bothWarnings[0]?.message).toContain("adversary");
    expect(bothWarnings[0]?.message).toContain("reviews.parallel=false");

    const explicitFalse = parseConfig({
      roles: { disabled: ["qa", "adversary"] },
      reviews: { parallel: false },
    }, "/workspace/project");
    expect(explicitFalse.reviews).toEqual({ parallel: false });
    expect(explicitFalse.warnings.filter((warning) => warning.path === "reviews.parallel")).toEqual([]);
  });

  test("emits one reviews.parallel warning when an invalid value also degrades for disabled reviewers", () => {
    const config = parseConfig({
      roles: { disabled: ["adversary"] },
      reviews: { parallel: "yes" },
    }, "/workspace/project");

    expect(config.reviews).toEqual({ parallel: false });
    const warnings = config.warnings.filter((warning) => warning.path === "reviews.parallel");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("Must be a boolean");
    expect(warnings[0]?.message).toContain("adversary");
    expect(warnings[0]?.message).toContain("reviews.parallel=false");
  });

  test("accepts absolute roots and tolerates non-object plugin options", () => {
    const absolute = parseConfig({ root: "/var/lib/team", dbPath: "/var/lib/team/state.db" }, "/project");
    expect(absolute.rootDir).toBe("/var/lib/team");
    expect(absolute.dbPath).toBe("/var/lib/team/state.db");

    const invalid = parseConfig("bad-options", "/project");
    expect(invalid.rootDir).toBe("/project/.team");
    expect(invalid.warnings[0]?.path).toBe("options");
  });
});
