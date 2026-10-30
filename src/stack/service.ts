import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StackConfig } from "../config";
import { cloneStackProfile, findHumanOwnedConflicts, hasStackErrors, mergeStackProfile, parseStackProfile, resolveScopeGlobs, type StackDiagnostic, type StackProfile } from "./profile";
import { detectStack } from "./detect";
import { createDetectionInput } from "./fs";
import { resolveStackProfile, type StackResolution } from "./resolve";
import type { RunRepository, RunRow } from "../state/runs";
import { ensureDirectory, runDirectory } from "../state/paths";
import { serializeTraceJson } from "../state/trace";

export interface StackServiceDependencies {
  readonly rootDir: string;
  readonly projectDir: string;
  readonly config: StackConfig;
  readonly runs?: RunRepository | null;
}

export interface StackUpdateResult {
  readonly ok: boolean;
  readonly profile?: StackProfile;
  readonly resolution?: StackResolution;
  readonly diagnostics: readonly StackDiagnostic[];
  readonly conflicts?: readonly string[];
  readonly error?: string;
}

export class StackService {
  constructor(private readonly deps: StackServiceDependencies) {}

  resolveForProject(): StackResolution {
    const detected = this.detect();
    return resolveStackProfile({
      human: this.readHuman(),
      override: this.deps.config.overrides,
      detected: detected.profile,
      detect: this.deps.config.detect,
    });
  }

  resolveForRun(run: RunRow, refresh: boolean): StackResolution {
    const stored = refresh ? undefined : parseStored(run.stack_json);
    const detected = this.detect();
    return resolveStackProfile({
      human: this.readHuman(),
      override: this.deps.config.overrides,
      stored,
      detected: detected.profile,
      detect: this.deps.config.detect,
    });
  }

  persist(run: RunRow, profile: StackProfile): void {
    if (!this.deps.runs) return;
    this.deps.runs.setStackJson(run.id, serializeTraceJson(profile));
    const directory = ensureDirectory(runDirectory(this.deps.rootDir, run.id));
    writeFileSync(path.join(directory, "stack.json"), `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  }

  updateRun(run: RunRow, patch: unknown): StackUpdateResult {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      return {
        ok: false,
        error: "patch must be an object.",
        diagnostics: [{ path: "patch", message: "Must be an object.", severity: "error" }],
      };
    }

    const current = this.resolveForRun(run, false);
    const humanRaw = this.readHuman();
    if (humanRaw !== undefined) {
      const human = parseStackProfile(humanRaw);
      if (human.profile && !hasStackErrors(human.diagnostics)) {
        const conflicts = findHumanOwnedConflicts(human.profile, patch);
        if (conflicts.length > 0) {
          return {
            ok: false,
            error: `The human-owned stack.json defines ${conflicts.join(", ")}; those fields cannot be changed by team_stack_update.`,
            diagnostics: human.diagnostics,
            conflicts,
          };
        }
      }
    }

    const merged = mergeStackProfile(current.profile, patch);
    if (!merged.merged || hasStackErrors(merged.diagnostics)) {
      return {
        ok: false,
        error: "The stack patch did not produce a valid profile.",
        diagnostics: merged.diagnostics,
      };
    }

    const profile: StackProfile = { ...cloneStackProfile(merged.merged), source: "researcher" };
    this.persist(run, profile);
    return {
      ok: true,
      profile,
      resolution: {
        profile,
        layer: "run",
        sources: ["run"],
        diagnostics: merged.diagnostics,
        globsDefaulted: resolveScopeGlobs(profile).defaulted,
      },
      diagnostics: merged.diagnostics,
    };
  }

  private readHuman(): unknown {
    try {
      const raw = readFileSync(path.join(this.deps.rootDir, "stack.json"), "utf8");
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private detect(): { readonly profile?: StackProfile; readonly diagnostics: readonly StackDiagnostic[] } {
    if (!this.deps.config.detect) return { diagnostics: [] };
    try {
      const profile = detectStack(createDetectionInput(this.deps.projectDir));
      return { profile, diagnostics: [] };
    } catch (error) {
      return {
        diagnostics: [{
          path: "detection",
          message: `Stack detection failed: ${error instanceof Error ? error.message : String(error)}`,
          severity: "warning",
        }],
      };
    }
  }
}

function parseStored(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
