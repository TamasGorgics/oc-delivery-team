import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import deliveryTeam, { getDeliveryTeamSnapshot } from "../../src/index";
import { ROLE_IDS } from "../../src/roles";
import { createFakeContext, fakeModel } from "../fakes/ctx";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("delivery-team plugin registration", () => {
  test("exports the expected plugin id and registers all roles and commands", async () => {
    const fake = createFakeContext({ projectDirectory: tempProject() });
    const cleanup = await deliveryTeam.setup(fake.context);
    assertCleanup(cleanup);

    expect(deliveryTeam.id).toBe("delivery-team");
    expect([...fake.state.agents.keys()].sort()).toEqual([...ROLE_IDS].sort());
    expect(fake.state.agents.get("team-lead")?.mode).toBe("primary");
    expect([...fake.state.commands.keys()]).toEqual(["team", "team-status", "team-retro"]);
    expect(fake.state.reloadCount).toBe(1);
    expect(fake.state.commandReloadCount).toBe(1);
    expect(getDeliveryTeamSnapshot(fake.context)?.commands).toEqual(["team", "team-status", "team-retro"]);
    for (const id of ROLE_IDS) expect(fake.state.agents.get(id)?.model).toBeUndefined();

    const snapshot = getDeliveryTeamSnapshot(fake.context);
    expect(snapshot?.models.roles.developer?.source).toBe("inherit");
    expect(snapshot?.models.events.some((event) => event.type === "model.diversity_warning")).toBe(true);

    await cleanup();
    expect(fake.state.commands.size).toBe(0);
    expect(fake.state.agentTransforms).toHaveLength(0);
    expect(getDeliveryTeamSnapshot(fake.context)).toBeUndefined();
  });

  test("respects disabled roles and remains idempotent for repeated setup", async () => {
    const fake = createFakeContext({ projectDirectory: tempProject(), options: { roles: { disabled: ["docs", "qa"] } } });
    const [cleanupA, cleanupB] = await Promise.all([
      deliveryTeam.setup(fake.context),
      deliveryTeam.setup(fake.context),
    ]);
    assertCleanup(cleanupA);
    assertCleanup(cleanupB);

    expect(cleanupA).toBe(cleanupB);
    expect(fake.state.agents.has("docs")).toBe(false);
    expect(fake.state.agents.has("qa")).toBe(false);
    expect(fake.state.agents.size).toBe(7);
    expect(fake.state.agentTransforms).toHaveLength(1);
    expect(fake.state.commands.size).toBe(3);
    expect(getDeliveryTeamSnapshot(fake.context)?.models.roles.docs).toBeUndefined();

    await cleanupA();
    await cleanupB();
    expect(fake.state.agentTransforms).toHaveLength(0);
    expect(fake.state.commands.size).toBe(0);
  });

  test("applies configured models, variants, steps, and context request parameters", async () => {
    const fake = createFakeContext({
      projectDirectory: tempProject(),
      options: {
        models: {
          roles: {
            developer: {
              model: "provider/coding",
              params: {
                reasoningEffort: "low",
                maxSteps: 7,
                temperature: 0.1,
                topP: 0.9,
                maxOutputTokens: 32,
              },
            },
          },
        },
      },
      models: [fakeModel("provider", "default"), fakeModel("provider", "coding")],
    });
    const cleanup = await deliveryTeam.setup(fake.context);
    assertCleanup(cleanup);

    const developer = fake.state.agents.get("developer");
    expect(developer?.model).toMatchObject({ id: "coding", providerID: "provider", variant: "low" });
    expect(developer?.steps).toBe(7);
    expect(getDeliveryTeamSnapshot(fake.context)?.models.roles.developer).toMatchObject({
      source: "role",
      model: "provider/coding#low",
      params: {
        temperature: 0.1,
        topP: 0.9,
        maxOutputTokens: 32,
        reasoningEffort: "low",
        maxSteps: 7,
      },
    });

    const event = await fake.invokeContextHook("developer", { existing: "kept" });
    expect(event.options).toEqual({ existing: "kept", temperature: 0.1, topP: 0.9, maxTokens: 32 });

    await cleanup();
    expect(fake.state.contextHook).toBeUndefined();
  });

  test("loads human-approved prompt files and rereads them when the transform reloads", async () => {
    const projectDirectory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-plugin-"));
    temporaryDirectories.push(projectDirectory);
    const promptDirectory = path.join(projectDirectory, ".team", "prompts");
    mkdirSync(promptDirectory, { recursive: true });
    const promptPath = path.join(promptDirectory, "team-lead.md");
    writeFileSync(promptPath, "Human-approved team lead prompt.", "utf8");

    const fake = createFakeContext({ projectDirectory });
    const cleanup = await deliveryTeam.setup(fake.context);
    assertCleanup(cleanup);
    expect(fake.state.agents.get("team-lead")?.system).toBe("Human-approved team lead prompt.");

    writeFileSync(promptPath, "Updated approved prompt.", "utf8");
    fake.replayAgentTransforms();
    expect(fake.state.agents.get("team-lead")?.system).toBe("Updated approved prompt.");
    await cleanup();
  });

  test("bad model references do not fail setup", async () => {
    const fake = createFakeContext({
      projectDirectory: tempProject(),
      options: { models: { roles: { developer: "not-a-model-reference" } } },
    });

    const cleanup = await deliveryTeam.setup(fake.context);
    assertCleanup(cleanup);
    expect(fake.state.agents.get("developer")?.model).toBeUndefined();
    expect(getDeliveryTeamSnapshot(fake.context)?.models.events.some(
      (event) => event.type === "model.fallback" && event.role === "developer",
    )).toBe(true);
    await cleanup();
  });
});

function tempProject(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "delivery-team-plugin-"));
  temporaryDirectories.push(directory);
  return directory;
}

function assertCleanup(value: unknown): asserts value is () => Promise<void> {
  if (typeof value !== "function") throw new Error("Expected plugin setup to return a cleanup function.");
}
