export const ARTIFACT_PATH_GUIDANCE = `## Artifact paths
The lead must pass the exact run artifact directory returned by \`team_start\`. Write artifacts with their full path, for example \`<artifact_dir>/brainstorm.md\`; never write a bare artifact filename in the project root. If the artifact directory is missing, ask the lead for it before writing. Do not ask another role to persist your artifact.`;

export function withArtifactPathGuidance(prompt: string): string {
  const text = prompt.trimEnd();
  if (text.includes("## Artifact paths")) return text;
  return `${text}\n\n${ARTIFACT_PATH_GUIDANCE}`;
}
