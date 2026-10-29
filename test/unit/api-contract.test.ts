import { describe, expect, test } from "bun:test";
import { Model, Plugin } from "@opencode/plugin";
import type { Agent } from "@opencode/schema/agent";

describe("installed OpenCode plugin API contract", () => {
  test("uses the Promise package root and Model.Ref format", () => {
    const ref = Model.Ref.parse("opencode/deepseek-v4.1-flash-free");
    const plugin = Plugin.define({ id: "contract-test", setup: () => {} });

    expect({ id: String(ref.id), providerID: String(ref.providerID) }).toEqual({
      id: "deepseek-v4.1-flash-free",
      providerID: "opencode",
    });
    expect(plugin.id).toBe("contract-test");
  });

  test("agent fields match the installed mode, permission, and request shapes", () => {
    const permission: Agent.Info["permissions"][number] = {
      action: "shell",
      resource: "*",
      effect: "deny",
    };
    const fields = {
      system: "API contract prompt.",
      mode: "subagent",
      steps: 2,
      permissions: [permission],
      request: { settings: {}, headers: {}, body: {} },
    } satisfies Partial<Agent.Info>;

    expect(fields.mode).toBe("subagent");
    expect(fields.permissions[0]?.action).toBe("shell");
  });
});
