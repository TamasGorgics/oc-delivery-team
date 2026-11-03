import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import deliveryTeam from "../../src/index";
import { createFakeContext } from "../fakes/ctx";

const [projectDir, runId, roleArg] = process.argv.slice(2);

if (!projectDir || !runId || (roleArg !== "qa" && roleArg !== "adversary")) {
  console.error("Expected project directory, run id, and reviewer role (qa|adversary) arguments.");
  process.exit(2);
}
const role = roleArg;
const artifact = role === "qa" ? "qa.md" : "adversary.md";
const contents = role === "qa"
  ? "# QA\n\n<!-- team-footer -->\nVERDICT: PASS\n<!-- /team-footer -->\n"
  : "# Adversary\n\n<!-- team-footer -->\nBLOCKERS: 0\n<!-- /team-footer -->\n";

const fake = createFakeContext({
  projectDirectory: projectDir,
  options: { reviews: { parallel: true } },
});
const cleanup = await deliveryTeam.setup(fake.context);
if (typeof cleanup !== "function") throw new Error("Plugin setup did not return a cleanup function.");

const context = {
  sessionID: `${role}-session`,
  agent: role,
  messageID: `${role}-message`,
  id: `${role}-call`,
};

try {
  const loopResult = await fake.invokeTool(
    "team_loop",
    { run: runId, reason: `${role} retry` },
    context,
  );
  const loop = (loopResult.output ?? {}) as {
    readonly ok?: boolean;
    readonly role?: string;
    readonly loop_count?: number;
    readonly error?: string;
  };
  if (!loop.ok || loop.role !== role || loop.loop_count !== 1) {
    throw new Error(`team_loop did not infer the ${role} scope: ${JSON.stringify(loop)}`);
  }

  const noteResult = await fake.invokeTool(
    "team_note",
    { run: runId, kind: "finding", text: `${role} finding` },
    context,
  );
  const note = (noteResult.output ?? {}) as { readonly ok?: boolean; readonly error?: string };
  if (!note.ok) throw new Error(`team_note failed for ${role}: ${note.error ?? "unknown error"}`);

  const runDirectory = path.join(projectDir, ".team", "runs", runId);
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(path.join(runDirectory, artifact), contents, "utf8");

  const statusResult = await fake.invokeTool("team_status", { run: runId }, context);
  const status = (statusResult.output ?? {}) as {
    readonly ok?: boolean;
    readonly error?: string;
    readonly review_wave?: {
      readonly enabled?: boolean;
      readonly active?: boolean;
      readonly members?: ReadonlyArray<{
        readonly role?: string;
        readonly gate?: { readonly ok?: boolean } | null;
      }>;
    };
  };
  if (!status.ok) throw new Error(`team_status failed for ${role}: ${status.error ?? "unknown error"}`);
  const wave = status.review_wave;
  if (!wave?.enabled || !wave.active) {
    throw new Error(`Expected an active review wave for ${role}: ${JSON.stringify(wave)}`);
  }
  const ownMember = wave.members?.find((member) => member.role === role);
  if (!ownMember?.gate?.ok) {
    throw new Error(`Expected the ${role} member gate to pass: ${JSON.stringify(ownMember)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await cleanup();
}
