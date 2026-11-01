import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactText } from "../state/privacy";
import type { EvalModelPreset } from "./types";

const RUN_TIMEOUT_MS = 15 * 60_000;
const MAX_CAPTURED_ERROR_CHARS = 1_000;

export interface EvalRunnerInput {
  readonly taskName: string;
  readonly fixtureDirectory: string;
  readonly dataRoot: string;
  readonly taskText: string;
  readonly packageRoot: string;
  readonly modelPreset?: EvalModelPreset;
  readonly timeoutMs?: number;
}

export interface EvalRunnerResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

export interface EvalRunner {
  run(input: EvalRunnerInput): Promise<EvalRunnerResult>;
}

export class OpenCodeCliEvalRunner implements EvalRunner {
  constructor(private readonly executable = "opencode") {}

  async run(input: EvalRunnerInput): Promise<EvalRunnerResult> {
    prepareOpenCodeProject(input);
    const arguments_ = ["--standalone", "run", "--print-logs", "--auto", "--agent", "team-lead"];
    if (input.modelPreset?.hostModel) arguments_.push("--model", input.modelPreset.hostModel);
    arguments_.push(input.taskText);

    const started = Date.now();
    const result = spawnSync(this.executable, arguments_, {
      cwd: input.fixtureDirectory,
      encoding: "utf8",
      timeout: input.timeoutMs ?? RUN_TIMEOUT_MS,
      maxBuffer: 8_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const durationMs = Date.now() - started;
    if (result.error) {
      const timedOut = "code" in result.error && result.error.code === "ETIMEDOUT";
      return {
        exitCode: null,
        timedOut,
        durationMs,
        error: clip(result.error.message),
      };
    }
    return {
      exitCode: result.status,
      timedOut: false,
      durationMs,
      ...(result.status === 0 ? {} : { error: clip(result.stderr || result.stdout || "OpenCode exited without a diagnostic.") }),
    };
  }
}

export function prepareOpenCodeProject(input: EvalRunnerInput): void {
  const pluginDirectory = path.join(input.fixtureDirectory, ".opencode", "plugins", "delivery-team");
  mkdirSync(pluginDirectory, { recursive: true });
  const sourceEntry = path.join(input.packageRoot, "src", "index.ts");
  writeFileSync(
    path.join(pluginDirectory, "index.ts"),
    `export { default } from ${JSON.stringify(sourceEntry)};\n`,
    "utf8",
  );

  const configPath = path.join(input.fixtureDirectory, "opencode.json");
  const existing = readProjectConfig(configPath);
  const existingPlugins = Array.isArray(existing.plugins) ? existing.plugins : [];
  const evalPlugin = {
    package: "delivery-team",
    options: {
      root: input.dataRoot,
      ...(input.modelPreset?.models ? { models: input.modelPreset.models } : {}),
      worktrees: { enabled: false },
    },
  };
  const plugins = [
    ...existingPlugins.filter((entry) => !isDeliveryTeamPlugin(entry)),
    evalPlugin,
  ];
  writeFileSync(configPath, `${JSON.stringify({ ...existing, plugins }, null, 2)}\n`, "utf8");
}

function readProjectConfig(filePath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Fixture opencode.json is invalid: ${errorMessage(error)}`);
  }
  if (!isRecord(value)) throw new Error("Fixture opencode.json must contain a JSON object.");
  return value;
}

function isDeliveryTeamPlugin(value: unknown): boolean {
  if (typeof value === "string") return value === "delivery-team" || value === "opencode-delivery-team";
  return isRecord(value)
    && (value.package === "delivery-team" || value.package === "opencode-delivery-team");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(value: string): string {
  return redactText(value).slice(-MAX_CAPTURED_ERROR_CHARS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
