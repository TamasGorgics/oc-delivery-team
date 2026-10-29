import { Plugin } from "@opencode/plugin";
import { Schema } from "effect";

let generation = 0;

function log(event: string, data: Record<string, unknown> = {}) {
  console.error(`[hello] ${event} ${JSON.stringify(data)}`);
}

const GreetingInput = Schema.Struct({
  name: Schema.String,
});

const GreetingOutput = Schema.Struct({
  greeting: Schema.String,
  runtime: Schema.String,
  appVersion: Schema.String,
  setupID: Schema.String,
});

export default Plugin.define({
  id: "hello",
  async setup(ctx) {
    const setupID = `${Date.now().toString(36)}-${++generation}`;
    const runtime = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`;
    let cleaned = false;

    log("setup", {
      setupID,
      runtime,
      app: ctx.app,
      directory: ctx.location.directory,
      options: ctx.options,
    });

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "greeting",
        description: "Return a greeting. Used by the M0.1 plugin loading probe.",
        input: GreetingInput,
        output: GreetingOutput,
        execute: async ({ name }, toolCtx) => {
          const greeting = `Hello, ${name}!`;
          log("greeting", {
            setupID,
            name,
            sessionID: toolCtx.sessionID,
            agent: toolCtx.agent,
            messageID: toolCtx.messageID,
            toolCallID: toolCtx.id,
          });
          return {
            output: { greeting, runtime, appVersion: ctx.app.version, setupID },
            content: [{ type: "text", text: greeting }],
            metadata: { plugin: "hello", setupID, runtime },
          };
        },
      });
    });

    log("tool-registered", { setupID });

    return () => {
      if (cleaned) {
        log("cleanup-skipped", { setupID, reason: "already cleaned" });
        return;
      }
      cleaned = true;
      log("cleanup", { setupID });
    };
  },
});
