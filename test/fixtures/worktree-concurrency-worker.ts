import deliveryTeam from "../../src/index";
import { createFakeContext } from "../fakes/ctx";

const [projectDir, runId, worker] = process.argv.slice(2);

if (!projectDir || !runId || !worker) {
  throw new Error("Expected project directory, run id, and worker name arguments.");
}

const fake = createFakeContext({
  projectDirectory: projectDir,
  options: { worktrees: { enabled: true } },
});
const cleanup = await deliveryTeam.setup(fake.context);
if (typeof cleanup !== "function") throw new Error("Plugin setup did not return a cleanup function.");
try {
  for (let index = 0; index < 9; index += 1) {
    const result = await fake.invokeTool(
      "team_advance",
      { run: runId },
      {
        sessionID: `${worker}-session`,
        agent: "team-lead",
        messageID: `${worker}-message-${index}`,
        id: `${worker}-advance-${index}`,
      },
    );
    const payload = (result.output ?? {}) as { readonly ok?: boolean; readonly error?: string };
    if (!payload.ok) throw new Error(`Advance ${index} failed for ${runId}: ${payload.error ?? "unknown error"}`);
  }
} finally {
  await cleanup();
}
