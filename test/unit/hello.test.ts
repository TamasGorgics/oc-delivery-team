import { describe, expect, spyOn, test } from "bun:test";
import hello from "../../.opencode/plugins/hello/index";

type Context = Parameters<typeof hello.setup>[0];
type Tool = Awaited<ReturnType<Context["tool"]["list"]>>[number];

function fakeContext(options: Record<string, unknown> = {}) {
  const tools: Tool[] = [];
  const context = {
    app: { name: "opencode", version: "2.2.0", channel: "test" },
    location: { directory: "/tmp/hello-test" },
    options,
    tool: {
      transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => {
        callback({ add: (tool) => tools.push(tool) });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Context;
  return { context, tools };
}

function fakeToolContext() {
  return {
    sessionID: "ses_test",
    agent: "build",
    messageID: "msg_test",
    id: "call_test",
    signal: new AbortController().signal,
    progress: async () => {},
  } as never;
}

describe("hello plugin", () => {
  test("registers a greeting tool and returns a text result", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { context, tools } = fakeContext({ probe: true });
      const cleanup = await hello.setup(context);

      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("greeting");
      expect(tools[0]?.description).toContain("M0.1");

      const result = await tools[0].execute({ name: "M0.1" }, fakeToolContext());

      expect(result.output).toMatchObject({
        greeting: "Hello, M0.1!",
        appVersion: "2.2.0",
      });
      expect(result.content).toEqual([{ type: "text", text: "Hello, M0.1!" }]);

      const setupLog = log.mock.calls.find((call) => String(call[0]).startsWith("[hello] setup "));
      expect(String(setupLog?.[0])).toContain('"probe":true');

      await cleanup?.();
      expect(log.mock.calls.some((call) => String(call[0]).startsWith("[hello] cleanup "))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test("repeated setup is safe and cleanup is idempotent", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = fakeContext();
      const second = fakeContext();
      const firstCleanup = await hello.setup(first.context);
      const secondCleanup = await hello.setup(second.context);

      const firstSetupID = (await first.tools[0].execute({ name: "first" }, fakeToolContext())).output?.setupID;
      const secondSetupID = (await second.tools[0].execute({ name: "second" }, fakeToolContext())).output?.setupID;
      expect(firstSetupID).not.toBe(secondSetupID);

      await firstCleanup?.();
      await firstCleanup?.();
      expect(log.mock.calls.filter((call) => String(call[0]).startsWith("[hello] cleanup ")).length).toBe(1);
      expect(log.mock.calls.some((call) => String(call[0]).startsWith("[hello] cleanup-skipped "))).toBe(true);

      await secondCleanup?.();
    } finally {
      log.mockRestore();
    }
  });
});
