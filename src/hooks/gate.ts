import path from "node:path";
import {
  extractEditedPaths,
  extractShellCommand,
  roleIdFromAgent,
  toolInputObject,
  type PluginContext,
} from "../compat";
import { StackService } from "../stack/service";
import { resolveScopeGlobs, type StackProfile } from "../stack/profile";
import { isPhase, phaseIndex, type Phase } from "../state/phases";
import { resolveSessionRun, type RunRow } from "../state/runs";
import type { ToolRuntime } from "../tools/runtime";

export interface ToolBeforeEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
  readonly input: unknown;
}

export type GateDenialCode =
  | "edit_phase_blocked"
  | "edit_path_unknown"
  | "scope_tests"
  | "scope_docs"
  | "scope_root"
  | "scope_outside_project"
  | "cli_approval_blocked"
  | "unresolved_run";

export interface GateTrace {
  readonly kind: string;
  readonly data: Record<string, unknown>;
  readonly once?: boolean;
}

export type GateDecision =
  | {
      readonly kind: "allow";
      readonly traces: readonly GateTrace[];
      readonly run?: RunRow;
      readonly phase?: Phase;
    }
  | {
      readonly kind: "deny";
      readonly code: GateDenialCode;
      readonly message: string;
      readonly traces: readonly GateTrace[];
      readonly run?: RunRow;
      readonly phase?: Phase;
    }
  | {
      readonly kind: "unresolved";
      readonly message: string;
      readonly traces: readonly GateTrace[];
      readonly run?: RunRow;
      readonly phase?: Phase;
    };

export class GateDenial extends Error {
  constructor(readonly code: GateDenialCode, message: string) {
    super(message);
    this.name = "GateDenial";
  }
}

interface ProfileEntry {
  readonly key: string;
  readonly profile: StackProfile;
  readonly tests: readonly string[];
  readonly docs: readonly string[];
  readonly testsDefaulted: boolean;
  readonly docsDefaulted: boolean;
}

const SCOPED_ROLES = new Set(["tester", "docs", "spec", "retro"]);

/**
 * Evaluate one execute.before event. This function is deliberately free of
 * host hooks so every branch can be unit-tested; the wrapper below applies the
 * strictness policy and traces the result.
 */
export function evaluateGate(
  runtime: ToolRuntime,
  event: ToolBeforeEvent,
  profileCache?: Map<string, ProfileEntry>,
): GateDecision {
  const traces: GateTrace[] = [];
  const editTool = runtime.config.gating.editTools.includes(event.tool);
  const role = roleIdFromAgent(event.agent);

  if (editTool && !role) {
    traces.push({
      kind: "gate.scope_skipped",
      data: { tool: event.tool, reason: "agent unavailable" },
      once: true,
    });
  }

  const command = extractShellCommand(event.tool, event.input);
  if (command) {
    const normalized = command.replace(/\s+/g, " ");
    const blocked = ["team lessons approve", "team prompts approve"]
      .find((value) => normalized.includes(value));
    if (blocked) {
      return deny(
        "cli_approval_blocked",
        [
          `Direct CLI approval ('${blocked}') is blocked in agent sessions.`,
          "Ask the human to run the approval command outside OpenCode; agents cannot approve their own lessons or prompts.",
        ].join(" "),
        traces,
      );
    }
  }

  if (!runtime.runs) {
    return unresolved(runtime.dbError
      ? `The delivery-team database is unavailable: ${runtime.dbError}`
      : "The delivery-team database is unavailable.", traces);
  }

  let resolved;
  try {
    resolved = resolveSessionRun(runtime.runs, event.sessionID);
  } catch (error) {
    return unresolved(`The delivery-team database could not be read: ${errorMessage(error)}`, traces);
  }
  if (!resolved.ok) return unresolved(resolved.message, traces);

  const run = resolved.run;
  if (!isPhase(run.phase)) return unresolved(`Run ${run.id} has an invalid phase.`, traces, run);
  const phase = run.phase;

  if (editTool) {
    const extraction = extractEditedPaths(event.tool, event.input, runtime.config.gating.pathKeys);
    if (!extraction.complete || extraction.paths.length === 0) {
      return deny(
        "edit_path_unknown",
        [
          `Could not determine the target path for '${event.tool}'.`,
          extraction.reason ?? "Use 'path' for edit/write, or configure gating.pathKeys.",
          "The call was blocked conservatively; no file was changed.",
        ].join(" "),
        traces,
        run,
        phase,
      );
    }

    if (phaseIndex(phase) < phaseIndex("implement")) {
      for (const target of extraction.paths) {
        const absolute = resolveTarget(runtime.config.projectDir, target);
        if (!isWithin(runtime.config.rootDir, absolute)) {
          return deny(
            "edit_phase_blocked",
            [
              `Source edits are blocked during '${phase}'.`,
              `Only paths under ${runtime.config.rootDir} may be edited before 'implement'.`,
              `'${target}' is outside that directory. Finish the spec/plan and call team_advance.`,
            ].join(" "),
            traces,
            run,
            phase,
          );
        }
      }
    }

    if (role && SCOPED_ROLES.has(role)) {
      const scope = scopeDecision(runtime, run, role, extraction.paths, traces, profileCache);
      if (scope) return { ...scope, run, phase };
    }
  }

  return { kind: "allow", traces, run, phase };
}

export function createGateHandler(runtime: ToolRuntime): (event: ToolBeforeEvent) => void {
  const profileCache = new Map<string, ProfileEntry>();

  return (event) => {
    const identity = {
      sessionId: event.sessionID,
      agent: event.agent,
      toolCallId: event.id,
    };
    runtime.trace.event(
      "tool.before",
      {
        tool: event.tool,
        message_id: event.messageID,
        input_keys: Object.keys(toolInputObject(event.input)),
      },
      identity,
    );

    let decision: GateDecision;
    try {
      decision = evaluateGate(runtime, event, profileCache);
    } catch (error) {
      runtime.trace.event(
        "gate.error",
        { tool: event.tool, message: errorMessage(error) },
        identity,
      );
      return;
    }

    emitTraces(runtime, decision, identity);

    if (decision.kind === "allow") return;

    if (decision.kind === "unresolved") {
      runtime.trace.event(
        "gate.unresolved",
        { tool: event.tool, message: decision.message, strict: runtime.config.gating.strict },
        runIdentity(identity, decision),
      );
      if (!runtime.config.gating.strict) return;
      throw new GateDenial("unresolved_run", decision.message);
    }

    runtime.trace.event(
      "gate.denied",
      { tool: event.tool, code: decision.code, message: decision.message },
      runIdentity(identity, decision),
    );
    throw new GateDenial(decision.code, decision.message);
  };
}

export async function registerGate(
  context: PluginContext,
  runtime: ToolRuntime,
): Promise<{ readonly dispose: () => Promise<void> }> {
  const registration = await context.tool.hook("execute.before", createGateHandler(runtime));
  return { dispose: registration.dispose };
}

function scopeDecision(
  runtime: ToolRuntime,
  run: RunRow,
  role: string,
  targets: readonly string[],
  traces: GateTrace[],
  profileCache?: Map<string, ProfileEntry>,
): GateDecision | undefined {
  for (const target of targets) {
    const absolute = resolveTarget(runtime.config.projectDir, target);
    if (isWithin(runtime.config.rootDir, absolute)) continue;

    if (role === "spec" || role === "retro") {
      return deny(
        "scope_root",
        `${role} may only edit files under ${runtime.config.rootDir} during '${run.phase}'. Keep artifacts in the run directory.`,
        traces,
      );
    }

    if (!isWithin(runtime.config.projectDir, absolute)) {
      return deny(
        "scope_outside_project",
        `${role} may only edit paths inside the project or under ${runtime.config.rootDir} during '${run.phase}'. '${target}' is outside both.`,
        traces,
      );
    }

    const entry = resolveProfile(runtime, run, profileCache);
    const globs = role === "tester" ? entry.tests : entry.docs;
    const defaulted = role === "tester" ? entry.testsDefaulted : entry.docsDefaulted;
    if (defaulted) {
      traces.push({
        kind: "gate.scope_default",
        data: {
          scope: role === "tester" ? "tests" : "docs",
          tests: entry.tests,
          docs: entry.docs,
          profile_source: entry.profile.source,
        },
        once: true,
      });
    }

    const relative = relativePosix(runtime.config.projectDir, absolute);
    if (!globs.some((glob) => matchesGlob(relative, glob))) {
      const label = role === "tester" ? "test" : "documentation";
      return deny(
        role === "tester" ? "scope_tests" : "scope_docs",
        [
          `${role} may only edit ${label} paths during '${run.phase}'.`,
          `'${target}' does not match the run's ${label} globs (${globs.join(", ")}).`,
          role === "tester"
            ? "Write a test path or update the Stack Profile with team_stack_update."
            : "Write a documentation path or update the Stack Profile with team_stack_update.",
        ].join(" "),
        traces,
      );
    }
  }
  return undefined;
}

function resolveProfile(
  runtime: ToolRuntime,
  run: RunRow,
  profileCache?: Map<string, ProfileEntry>,
): ProfileEntry {
  const key = `${run.id}\u0000${run.stack_json ?? ""}`;
  const cached = profileCache?.get(run.id);
  if (cached?.key === key) return cached;

  const service = new StackService({
    rootDir: runtime.config.rootDir,
    projectDir: runtime.config.projectDir,
    config: runtime.config.stack,
    runs: runtime.runs,
  });
  const resolution = service.resolveForRun(run, false);
  const globs = resolveScopeGlobs(resolution.profile);
  const components = resolution.profile.components;
  const entry: ProfileEntry = {
    key,
    profile: resolution.profile,
    tests: globs.tests,
    docs: globs.docs,
    // Track each scope separately so a tester edit does not report a default
    // merely because documentation globs were missing (and vice versa).
    testsDefaulted: components.length === 0 || components.some((item) => item.globs.tests.length === 0),
    docsDefaulted: components.length === 0 || components.some((item) => item.globs.docs.length === 0),
  };
  if (profileCache) {
    if (profileCache.size >= 64) {
      const oldest = profileCache.keys().next().value;
      if (oldest !== undefined) profileCache.delete(oldest);
    }
    profileCache.set(run.id, entry);
  }
  return entry;
}

function deny(
  code: GateDenialCode,
  message: string,
  traces: readonly GateTrace[],
  run?: RunRow,
  phase?: Phase,
): GateDecision {
  return { kind: "deny", code, message, traces, ...(run ? { run } : {}), ...(phase ? { phase } : {}) };
}

function unresolved(
  message: string,
  traces: readonly GateTrace[],
  run?: RunRow,
  phase?: Phase,
): GateDecision {
  return {
    kind: "unresolved",
    message: [
      `Gating could not resolve an open run for this tool call. ${message}`,
      "If this call does not belong to a run, ask the human to disable gating.strict.",
    ].join(" "),
    traces,
    ...(run ? { run } : {}),
    ...(phase ? { phase } : {}),
  };
}

function emitTraces(
  runtime: ToolRuntime,
  decision: GateDecision,
  identity: { readonly sessionId: string; readonly agent: string; readonly toolCallId: string },
): void {
  const seen = new Set<string>();
  for (const trace of decision.traces) {
    const signature = `${trace.kind}:${JSON.stringify(trace.data)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    if (trace.once && decision.run && runtime.runs) {
      try {
        if (runtime.runs.hasEvent(decision.run.id, trace.kind)) continue;
      } catch {
        // If the event lookup fails, let the normal trace path record the attempt.
      }
    }
    runtime.trace.event(trace.kind, trace.data, runIdentity(identity, decision));
  }
}

function runIdentity(
  identity: { readonly sessionId: string; readonly agent: string; readonly toolCallId: string },
  decision: GateDecision,
): {
  readonly sessionId: string;
  readonly agent: string;
  readonly toolCallId: string;
  readonly runId?: string;
  readonly phase?: Phase;
} {
  return {
    ...identity,
    ...(decision.run ? { runId: decision.run.id } : {}),
    ...(decision.phase ? { phase: decision.phase } : {}),
  };
}

function resolveTarget(projectDir: string, target: string): string {
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(projectDir, target);
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function relativePosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

function matchesGlob(relative: string, glob: string): boolean {
  try {
    return path.matchesGlob(relative, glob);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
