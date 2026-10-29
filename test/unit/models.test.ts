import { describe, expect, test } from "bun:test";
import { parseConfig } from "../../src/config";
import { resolveModels } from "../../src/models";
import type { CatalogModel, ModelCatalog } from "../../src/compat";

describe("model routing", () => {
  test("leaves every role model unset with zero config and records an in-memory snapshot", () => {
    const resolution = resolveModels(parseConfig(undefined, "/project").models, catalog());

    expect(Object.keys(resolution.snapshot.roles)).toHaveLength(9);
    for (const role of Object.values(resolution.routes)) {
      expect(role?.model).toBeNull();
      expect(role?.source).toBe("inherit");
    }
    expect(resolution.routes["team-lead"]?.steps).toBeUndefined();
    expect(resolution.routes.developer?.steps).toBe(80);
    expect(resolution.snapshot.events.some((event) => event.type === "model.diversity_warning")).toBe(true);
  });

  test("resolves role overrides before tiers and default, and honors roleTier moves", () => {
    const config = parseConfig({
      models: {
        default: "provider/default",
        tiers: { reasoning: "provider/reasoning", coding: "provider/coding", fast: "provider/fast" },
        roles: { developer: "provider/developer" },
        roleTier: { tester: "fast" },
      },
    }, "/project").models;
    const resolution = resolveModels(config, catalog([
      model("provider", "default"),
      model("provider", "reasoning"),
      model("provider", "coding"),
      model("provider", "fast"),
      model("provider", "developer"),
    ]));

    expect(resolution.routes.developer).toMatchObject({ model: "provider/developer#medium", source: "role" });
    expect(resolution.routes.spec).toMatchObject({ model: "provider/reasoning#high", source: "tier" });
    expect(resolution.routes.tester).toMatchObject({ model: "provider/fast", source: "tier", tier: "fast" });
    expect(resolution.routes.researcher).toMatchObject({ model: "provider/fast", source: "tier" });
  });

  test("falls back in order through fallback list, tier, default, and inheritance", () => {
    const config = parseConfig({
      models: {
        default: "provider/default",
        tiers: { coding: "provider/tier" },
        roleTier: { qa: "fast" },
        roles: {
          developer: { model: "provider/missing", fallback: ["provider/backup"] },
          tester: { model: "provider/missing-role" },
          qa: { model: "provider/missing-qa" },
        },
      },
    }, "/project").models;
    const resolution = resolveModels(config, catalog([
      model("provider", "default"),
      model("provider", "tier"),
      model("provider", "backup"),
    ]));

    expect(resolution.routes.developer).toMatchObject({ model: "provider/backup#medium", source: "fallback" });
    expect(resolution.routes.tester).toMatchObject({ model: "provider/tier#medium", source: "tier" });
    expect(resolution.routes.qa).toMatchObject({ model: "provider/default", source: "default" });
    expect(resolution.snapshot.events.filter((event) => event.type === "model.fallback").length).toBeGreaterThanOrEqual(3);

    const noValidModels = resolveModels(
      parseConfig({ models: { roles: { developer: "provider/nope" } } }, "/project").models,
      catalog([]),
    );
    expect(noValidModels.routes.developer).toMatchObject({ model: null, source: "inherit" });
  });

  test("falls back for unavailable providers, disabled models, and models without tool support", () => {
    const config = parseConfig({
      models: {
        tiers: { coding: { model: "provider/no-tools", fallback: ["provider/backup"] } },
        roles: {
          developer: { model: "offline/model", fallback: ["provider/backup"] },
          qa: { model: "provider/disabled", fallback: ["provider/backup"] },
        },
      },
    }, "/project").models;
    const resolution = resolveModels(config, catalog([
      model("provider", "no-tools", { tools: false, temperature: false }),
      model("provider", "backup"),
      model("provider", "disabled", { enabled: false }),
    ], { providers: [{ id: "provider", activation: "enabled" }] }));

    expect(resolution.routes.developer).toMatchObject({ model: "provider/backup#medium", source: "fallback" });
    expect(resolution.routes.tester).toMatchObject({ model: "provider/backup#medium", source: "fallback" });
    expect(resolution.routes.qa).toMatchObject({ model: "provider/backup#medium", source: "fallback" });

    const providerDisabled = resolveModels(
      parseConfig({ models: { roles: { developer: { model: "provider/disabled", fallback: ["provider/backup"] } } } }, "/project").models,
      catalog([
        model("provider", "disabled"),
        model("provider", "backup"),
      ], { providers: [{ id: "provider", activation: "disabled" }] }),
    );
    expect(providerDisabled.routes.developer?.model).toBeNull();
    expect(providerDisabled.snapshot.events.some((event) => event.reason.includes("disabled"))).toBe(true);
  });

  test("filters and maps supported request parameters and applies reasoning variants", () => {
    const config = parseConfig({
      models: {
        roles: {
          developer: {
            model: "provider/code",
            params: {
              temperature: 0.25,
              topP: 0.8,
              reasoningEffort: "low",
              maxSteps: 12,
              maxOutputTokens: 1200,
              unknownSetting: true,
            },
          },
        },
      },
    }, "/project").models;
    const resolution = resolveModels(config, catalog([model("provider", "code")]));
    const route = resolution.routes.developer;

    expect(route?.model).toBe("provider/code#low");
    expect(route?.steps).toBe(12);
    expect(route?.requestOptions).toEqual({ temperature: 0.25, topP: 0.8, maxTokens: 1200 });
    expect(route?.params).toMatchObject({
      temperature: 0.25,
      topP: 0.8,
      reasoningEffort: "low",
      maxSteps: 12,
      maxOutputTokens: 1200,
    });
    expect(route?.params).not.toHaveProperty("unknownSetting");
    expect(resolution.snapshot.events.some((event) => event.reason.includes("unknownSetting"))).toBe(true);
  });

  test("drops unsupported capabilities and malformed parameter values with warnings", () => {
    const config = parseConfig({
      models: {
        roles: {
          developer: {
            model: "provider/no-temperature",
            params: {
              temperature: 0.4,
              topP: 1.2,
              reasoningEffort: "xhigh",
              maxSteps: 0,
              maxOutputTokens: -1,
            },
          },
        },
      },
    }, "/project").models;
    const resolution = resolveModels(config, catalog([
      model("provider", "no-temperature", {
        tools: true,
        temperature: false,
        variants: ["low"],
      }),
    ]));
    const route = resolution.routes.developer;

    expect(route?.requestOptions).toEqual({});
    expect(route?.steps).toBe(80);
    expect(route?.params).not.toHaveProperty("temperature");
    expect(route?.params).not.toHaveProperty("topP");
    expect(route?.params).not.toHaveProperty("reasoningEffort");
    expect(route?.params).not.toHaveProperty("maxOutputTokens");
    expect(resolution.snapshot.events.filter((event) => event.type === "model.param_unsupported").length).toBeGreaterThanOrEqual(5);
  });

  test("warns on duplicate effective models, including two inherited roles, without swapping", () => {
    const inherited = resolveModels(parseConfig(undefined, "/project").models, catalog());
    expect(inherited.snapshot.events.some((event) => event.type === "model.diversity_warning")).toBe(true);

    const configured = resolveModels(
      parseConfig({
        models: {
          roles: {
            developer: "provider/shared",
            adversary: "provider/shared#low",
          },
        },
      }, "/project").models,
      catalog([model("provider", "shared")]),
    );
    expect(configured.routes.developer?.model).toBe("provider/shared#medium");
    expect(configured.routes.adversary?.model).toBe("provider/shared#low");
    expect(configured.snapshot.events.some((event) => event.type === "model.diversity_warning")).toBe(true);

    const disabled = resolveModels(
      parseConfig(undefined, "/project").models,
      catalog(),
      ["adversary"],
    );
    expect(disabled.snapshot.events.some((event) => event.type === "model.diversity_warning")).toBe(false);
  });

  test("does not throw for invalid model configuration or unavailable catalogs", () => {
    const badConfig = parseConfig({ models: { default: "not-a-reference", auto: true } }, "/project").models;
    const resolution = resolveModels(badConfig, {
      models: [],
      providers: [],
      modelsAvailable: false,
      providersAvailable: false,
      defaultLookupSucceeded: false,
      warnings: ["catalog request failed"],
    });

    expect(resolution.routes.developer?.model).toBeNull();
    expect(resolution.snapshot.events.some((event) => event.type === "model.auto_unsupported")).toBe(true);
    expect(resolution.snapshot.events.some((event) => event.type === "model.catalog_unavailable")).toBe(true);
    expect(resolution.snapshot.events.some((event) => event.type === "model.fallback")).toBe(true);
  });
});

function catalog(
  models: readonly CatalogModel[] = [model("provider", "default")],
  overrides: Partial<ModelCatalog> = {},
): ModelCatalog {
  return {
    models,
    providers: [{ id: "provider", activation: "enabled" }],
    defaultModel: models[0],
    modelsAvailable: true,
    providersAvailable: true,
    defaultLookupSucceeded: true,
    warnings: [],
    ...overrides,
  };
}

function model(providerID: string, modelID: string, overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    providerID,
    modelID,
    reference: `${providerID}/${modelID}`,
    enabled: true,
    tools: true,
    temperature: true,
    variants: ["low", "medium", "high"],
    outputLimit: 8192,
    ...overrides,
  };
}
