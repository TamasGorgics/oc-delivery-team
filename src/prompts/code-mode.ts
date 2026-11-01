/**
 * The OpenCode `execute` tool is not unrestricted JavaScript. Keeping this
 * guidance attached to every effective prompt prevents agents from trying
 * imports or native I/O inside Code Mode.
 */
export const CODE_MODE_GUIDANCE = `## Code Mode runtime
When using the execute tool, call plugin tools as \`tools.team_*\` directly. Do not use \`import()\`, \`require()\`, classes, BigInt, timers, filesystem APIs, or \`fetch\` in Code Mode. Use the available read, write, and shell tools for file and command operations.`;

export function withCodeModeGuidance(prompt: string): string {
  const text = prompt.trimEnd();
  if (text.includes("## Code Mode runtime")) return text;
  return `${text}\n\n${CODE_MODE_GUIDANCE}`;
}
