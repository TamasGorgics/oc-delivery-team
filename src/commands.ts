import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { PluginContext } from "./compat";

export function createCommands(context: PluginContext): readonly CommandDefinition[] {
  return [
    {
      name: "team",
      description: "Start a delivery-team run for a goal.",
      execute: async (invocation) => {
        const goal = invocation.prompt.text.trim();
        await context.session.switchAgent({ sessionID: invocation.sessionID, agent: "team-lead" });
        await sendPrompt(context, invocation, goal
          ? `Start a delivery-team run and follow the pipeline and phase gates. Call team_start for this goal:\n\n${goal}`
          : "Start a delivery-team run. Ask the human for a goal before calling team_start, then follow the pipeline and phase gates.");
      },
    },
    {
      name: "team-status",
      description: "Summarize the current delivery-team run.",
      execute: async (invocation) => {
        await sendPrompt(
          context,
          invocation,
          "Call team_status for the current run, then summarize its phase, progress, blockers, and next action.",
        );
      },
    },
    {
      name: "team-retro",
      description: "Run the retrospective phase for the current delivery-team run.",
      execute: async (invocation) => {
        await sendPrompt(
          context,
          invocation,
          "Check the current run with team_status, then run its retro phase and summarize the resulting findings.",
        );
      },
    },
  ];
}

export async function registerCommands(context: PluginContext): Promise<() => Promise<void>> {
  const commands = createCommands(context);
  const registration = await context.command.transform((editor) => {
    for (const command of commands) editor.add(command);
  });
  return registration.dispose;
}

async function sendPrompt(
  context: PluginContext,
  invocation: Parameters<CommandDefinition["execute"]>[0],
  text: string,
): Promise<void> {
  const { prompt } = invocation;
  await context.session.prompt({
    sessionID: invocation.sessionID,
    text,
    ...(prompt.files ? { files: prompt.files } : {}),
    ...(prompt.agents ? { agents: prompt.agents } : {}),
    ...(prompt.skills ? { skills: prompt.skills } : {}),
    delivery: invocation.delivery,
  });
}
