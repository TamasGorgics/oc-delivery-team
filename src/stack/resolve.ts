import {
  emptyStackProfile,
  hasStackErrors,
  mergeStackProfile,
  parseStackProfile,
  resolveScopeGlobs,
  type StackDiagnostic,
  type StackProfile,
  type StackSource,
} from "./profile";

export type StackLayer = "human" | "override" | "run" | "detected" | "empty";

export interface StackResolutionInput {
  readonly human?: unknown;
  readonly override?: unknown;
  readonly stored?: unknown;
  readonly detected?: StackProfile;
  readonly detect: boolean;
}

export interface StackResolution {
  readonly profile: StackProfile;
  readonly layer: StackLayer;
  /** Resolution layers that contributed, highest priority first. */
  readonly sources: readonly StackLayer[];
  readonly diagnostics: readonly StackDiagnostic[];
  readonly globsDefaulted: boolean;
}

export function resolveStackProfile(input: StackResolutionInput): StackResolution {
  const diagnostics: StackDiagnostic[] = [];

  const human = input.human === undefined ? undefined : parseStackProfile(input.human);
  if (human) {
    diagnostics.push(...human.diagnostics);
    if (human.profile && !hasStackErrors(human.diagnostics)) {
      const profile = withSource(human.profile, "human");
      return result(profile, "human", ["human"], diagnostics);
    }
  }

  let profile: StackProfile;
  let layer: StackLayer;
  let sources: StackLayer[];

  if (input.stored !== undefined) {
    const stored = parseStackProfile(input.stored);
    diagnostics.push(...stored.diagnostics);
    if (stored.profile && !hasStackErrors(stored.diagnostics)) {
      profile = withSource(stored.profile, "researcher");
      layer = "run";
      sources = ["run"];
    } else {
      profile = input.detect && input.detected ? withSource(input.detected, "detected") : emptyStackProfile();
      layer = input.detect && input.detected ? "detected" : "empty";
      sources = [layer];
    }
  } else if (input.detect && input.detected) {
    profile = withSource(input.detected, "detected");
    layer = "detected";
    sources = ["detected"];
  } else {
    profile = emptyStackProfile();
    layer = "empty";
    sources = ["empty"];
  }

  if (input.override !== undefined) {
    const merged = mergeStackProfile(profile, input.override);
    diagnostics.push(...merged.diagnostics);
    if (merged.merged && !hasStackErrors(merged.diagnostics)) {
      profile = withSource(merged.merged, "human");
      layer = "override";
      sources = [layer, ...sources];
    }
  }

  return result(profile, layer, sources, diagnostics);
}

export function stackSourceForLayer(layer: StackLayer): StackSource {
  switch (layer) {
    case "human":
    case "override":
      return "human";
    case "run":
      return "researcher";
    case "detected":
    case "empty":
      return "detected";
  }
}

function withSource(profile: StackProfile, source: StackSource): StackProfile {
  return { ...profile, source };
}

function result(
  profile: StackProfile,
  layer: StackLayer,
  sources: readonly StackLayer[],
  diagnostics: readonly StackDiagnostic[],
): StackResolution {
  return {
    profile,
    layer,
    sources: [...new Set(sources)],
    diagnostics,
    globsDefaulted: resolveScopeGlobs(profile).defaulted,
  };
}
