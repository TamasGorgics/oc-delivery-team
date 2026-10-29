import { describe, expect, test } from "bun:test";
import {
  formatModelReference,
  parseModelReference,
  pluginOptions,
  projectDirectory,
  readModelCatalog,
  roleIdFromAgent,
  setAgentModel,
  type AgentDraft,
} from "../../src/compat";
import { createFakeContext, fakeModel } from "../fakes/ctx";

describe("OpenCode compatibility boundary", () => {
  test("normalizes host catalog envelopes and reads the project directory from context", async () => {
    const fake = createFakeContext({
      projectDirectory: "/workspace/repo",
      options: { models: { default: "provider/default" } },
      models: [fakeModel("provider", "default")],
    });

    const catalog = await readModelCatalog(fake.context);
    expect(projectDirectory(fake.context)).toBe("/workspace/repo");
    expect(pluginOptions(fake.context)).toEqual({ models: { default: "provider/default" } });
    expect(catalog.modelsAvailable).toBe(true);
    expect(catalog.providersAvailable).toBe(true);
    expect(catalog.defaultLookupSucceeded).toBe(true);
    expect(catalog.models[0]).toMatchObject({
      providerID: "provider",
      modelID: "default",
      reference: "provider/default",
      tools: true,
    });
    expect(catalog.defaultModel?.reference).toBe("provider/default");
  });

  test("keeps catalog failures non-fatal and records diagnostics", async () => {
    const fake = createFakeContext({
      modelListError: new Error("offline"),
      providerListError: new Error("provider endpoint failed"),
      modelDefaultError: new Error("no default"),
    });

    const catalog = await readModelCatalog(fake.context);
    expect(catalog.modelsAvailable).toBe(false);
    expect(catalog.providersAvailable).toBe(false);
    expect(catalog.defaultLookupSucceeded).toBe(false);
    expect(catalog.warnings).toHaveLength(3);
    expect(catalog.warnings.join(" ")).toContain("offline");
  });

  test("parses and formats host model references and adapts agent ids", () => {
    const reference = parseModelReference("provider/model-with/slash#low");
    expect(formatModelReference(reference)).toBe("provider/model-with/slash#low");
    expect(roleIdFromAgent("developer")).toBe("developer");
    expect(roleIdFromAgent("unknown-agent")).toBeUndefined();

    const draft = { model: reference } as unknown as AgentDraft;
    setAgentModel(draft, "provider/other");
    expect(draft.model).toMatchObject({ id: "other", providerID: "provider" });
    setAgentModel(draft, null);
    expect(draft.model).toBeUndefined();
  });
});
