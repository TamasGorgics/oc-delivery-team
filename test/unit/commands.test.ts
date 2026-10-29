import { describe, expect, test } from "bun:test";
import { registerCommands } from "../../src/commands";
import { createFakeContext } from "../fakes/ctx";

describe("delivery-team commands", () => {
  test("registers the three commands and starts /team on the lead first", async () => {
    const fake = createFakeContext();
    const dispose = await registerCommands(fake.context);

    expect([...fake.state.commands.keys()]).toEqual(["team", "team-status", "team-retro"]);
    await fake.invokeCommand("team", "Add pagination to the results view");

    expect(fake.state.switchedAgents).toEqual([{ sessionID: "session-1", agent: "team-lead" }]);
    expect(fake.state.actions).toEqual(["switch:team-lead", "prompt"]);
    expect(fake.state.prompts[0]?.text).toContain("Call team_start");
    expect(fake.state.prompts[0]?.text).toContain("Add pagination to the results view");
    await dispose();
  });

  test("status and retro prompt the current session without switching agents", async () => {
    const fake = createFakeContext();
    const dispose = await registerCommands(fake.context);

    await fake.invokeCommand("team-status");
    await fake.invokeCommand("team-retro");

    expect(fake.state.switchedAgents).toEqual([]);
    expect(fake.state.prompts[0]?.text).toContain("team_status");
    expect(fake.state.prompts[1]?.text).toContain("retro phase");
    expect(fake.state.actions).toEqual(["prompt", "prompt"]);

    await dispose();
    expect(fake.state.commands.size).toBe(0);
  });

  test("asks for a goal instead of starting an empty run", async () => {
    const fake = createFakeContext();
    await registerCommands(fake.context);

    await fake.invokeCommand("team");
    expect(fake.state.prompts[0]?.text).toContain("Ask the human for a goal");
  });
});
