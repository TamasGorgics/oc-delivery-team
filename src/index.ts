import { readFileSync } from "node:fs";
import path from "node:path";
import { Plugin } from "@opencode/plugin";
import {
  pluginOptions,
  projectDirectory,
  readModelCatalog,
  roleIdFromAgent,
  setAgentModel,
  setAgentName,
  upsertAgent,
  type AgentDraft,
  type PluginContext,
} from "./compat";
import { registerCommands } from "./commands";
import { parseConfig, type ConfigWarning, type DeliveryTeamConfig } from "./config";
import { resolveModels, type ModelResolution } from "./models";
import { getDefaultPrompt } from "./prompts";
import {
  enabledRoles,
  rolePermissionRules,
  type PermissionRule,
  type RoleDefinition,
  type RoleId,
} from "./roles";
import { openDatabase, type TeamDatabase } from "./state/db";
import { LessonsRepository } from "./state/lessons";
import { resolveMainRepoDirectory } from "./state/paths";
import { RunRepository } from "./state/runs";
import { Tracer } from "./state/trace";
import { registerTools, type ToolRuntime } from "./tools/runtime";

export interface DeliveryTeamSnapshot {
  readonly configWarnings: readonly ConfigWarning[];
  readonly setupWarnings: readonly string[];
  readonly commands: readonly string[];
  readonly tools: readonly string[];
  readonly models: ModelResolution["snapshot"];
  readonly database: {
    readonly path: string;
    readonly driver: string | null;
    readonly status: "ready" | "unavailable";
    readonly error?: string;
    readonly schemaVersion?: number;
  };
}

const activeSetups = new WeakMap<PluginContext, Promise<() => Promise<void>>>();
const snapshots = new WeakMap<PluginContext, DeliveryTeamSnapshot>();

export const deliveryTeam = Plugin.define({
  id: "delivery-team",
  setup: setupDeliveryTeam,
});

export default deliveryTeam;

export function getDeliveryTeamSnapshot(context: PluginContext): DeliveryTeamSnapshot | undefined {
  return snapshots.get(context);
}

async function setupDeliveryTeam(context: PluginContext): Promise<() => Promise<void>> {
  const existing = activeSetups.get(context);
  if (existing) return existing;

  const setupPromise = setupOnce(context);
  activeSetups.set(context, setupPromise);

  try {
    return await setupPromise;
  } catch (error) {
    activeSetups.delete(context);
    throw error;
  }
}

async function setupOnce(context: PluginContext): Promise<() => Promise<void>> {
  const projectDir = projectDirectory(context);
  const mainRepoDir = resolveMainRepoDirectory(projectDir);
  const config = parseConfig(pluginOptions(context), projectDir, mainRepoDir);
  const setupWarnings: string[] = [];
  const catalog = await readModelCatalog(context);
  const modelResolution = resolveModels(config.models, catalog, config.roles.disabled);
  const disposers: Array<() => Promise<void>> = [];
  let commandNames: string[] = [];
  let toolNames: string[] = [];
  let db: TeamDatabase | null = null;
  let dbError: string | undefined;
  let schemaVersion: number | undefined;

  try {
    try {
      const opened = await openDatabase(config.dbPath);
      db = opened.db;
      schemaVersion = opened.migration.toVersion;
    } catch (error) {
      dbError = errorMessage(error);
      setupWarnings.push(`database.open: ${dbError}`);
    }

    const tracer = new Tracer(db, undefined, (traceError) => {
      if (setupWarnings.length < 50) {
        setupWarnings.push(`trace.${traceError.operation}: ${traceError.message}`);
      }
    });
    const runs = db ? new RunRepository(db) : null;
    const lessons = db ? new LessonsRepository(db) : null;
    const runtime: ToolRuntime = {
      config,
      db,
      ...(dbError ? { dbError } : {}),
      trace: tracer,
      runs,
      lessons,
      modelSnapshot: modelResolution.snapshot,
    };

    if (db) {
      tracer.event("models.snapshot", {
        roles: modelResolution.snapshot.roles,
        events: modelResolution.snapshot.events,
      });
    }

    const agentRegistration = await context.agent.transform((editor) => {
      for (const role of enabledRoles(config.roles.disabled)) {
        const route = modelResolution.routes[role.id];
        upsertAgent(editor, role.id, (draft) => {
          applyRoleDraft(draft, role, route, config);
        });
      }
    });
    disposers.push(agentRegistration.dispose);

    const commandDisposer = await registerCommands(context);
    disposers.push(commandDisposer);
    try {
      await context.command.reload();
    } catch (error) {
      setupWarnings.push(`command.reload: ${errorMessage(error)}`);
    }
    try {
      const commands = await context.command.list();
      commandNames = commands.data.map((command) => command.name);
    } catch (error) {
      setupWarnings.push(`command.list: ${errorMessage(error)}`);
    }

    try {
      const toolRegistration = await registerTools(context, runtime);
      disposers.push(toolRegistration.dispose);
      toolNames = [...toolRegistration.names];
    } catch (error) {
      setupWarnings.push(`tool.registration: ${errorMessage(error)}`);
    }

    if (hasRequestOptions(modelResolution)) {
      const hookRegistration = await context.session.hook("context", (event) => {
        try {
          const role = roleIdFromAgent(event.agent);
          if (!role) return;
          const route = modelResolution.routes[role];
          if (!route) return;
          const options = route.requestOptions;
          if (options.temperature !== undefined) event.options.temperature = options.temperature;
          if (options.topP !== undefined) event.options.topP = options.topP;
          if (options.maxTokens !== undefined) event.options.maxTokens = options.maxTokens;
        } catch (error) {
          setupWarnings.push(`model.context_hook: ${errorMessage(error)}`);
        }
      });
      disposers.push(hookRegistration.dispose);
    }

    // Replays the transform so changed human-approved prompt files are read on setup.
    try {
      await context.agent.reload();
    } catch (error) {
      setupWarnings.push(`agent.reload: ${errorMessage(error)}`);
    }

    const snapshot: DeliveryTeamSnapshot = {
      configWarnings: config.warnings,
      setupWarnings,
      commands: commandNames,
      tools: toolNames,
      models: modelResolution.snapshot,
      database: {
        path: config.dbPath,
        driver: db?.driver ?? null,
        status: db ? "ready" : "unavailable",
        ...(dbError ? { error: dbError } : {}),
        ...(schemaVersion !== undefined ? { schemaVersion } : {}),
      },
    };
    snapshots.set(context, snapshot);

    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      activeSetups.delete(context);
      snapshots.delete(context);
      for (const dispose of [...disposers].reverse()) {
        try {
          await dispose();
        } catch {
          // Cleanup is best-effort; one registration must not prevent the rest from disposing.
        }
      }
      try {
        db?.close();
      } catch {
        // Closing a broken database is best-effort.
      }
    };

    return cleanup;
  } catch (error) {
    for (const dispose of [...disposers].reverse()) {
      try {
        await dispose();
      } catch {
        // Preserve the setup error while still attempting all cleanup.
      }
    }
    try {
      db?.close();
    } catch {
      // Preserve the setup error.
    }
    throw error;
  }
}

function applyRoleDraft(
  draft: AgentDraft,
  role: RoleDefinition,
  route: ModelResolution["routes"][keyof ModelResolution["routes"]],
  config: DeliveryTeamConfig,
): void {
  setAgentName(draft, role.name);
  draft.description = role.description;
  draft.mode = role.mode;
  draft.hidden = false;
  draft.system = resolvePrompt(config.rootDir, role.id);
  draft.steps = route?.steps;
  if (route?.steps === undefined) delete draft.steps;
  setAgentModel(draft, route?.model ?? null);

  const roleRules = rolePermissionRules(role, config.rootDir);
  draft.permissions = mergeRolePermissions(draft.permissions, roleRules);
}

function resolvePrompt(rootDir: string, role: RoleId): string {
  const defaultPrompt = getDefaultPrompt(role);
  const overridePath = path.join(rootDir, "prompts", `${role}.md`);
  try {
    const override = readFileSync(overridePath, "utf8").trim();
    return override || defaultPrompt;
  } catch {
    return defaultPrompt;
  }
}

function mergeRolePermissions(existing: AgentDraft["permissions"], additions: PermissionRule[]) {
  const replacementKeys = new Set(additions.map(permissionKey));
  return [
    ...existing.filter((rule) => !replacementKeys.has(permissionKey(rule))),
    ...additions,
  ];
}

function permissionKey(rule: PermissionRule): string {
  return `${rule.action}\u0000${rule.resource}\u0000${rule.effect}`;
}

function hasRequestOptions(resolution: ModelResolution): boolean {
  return Object.values(resolution.routes).some((route) => route !== undefined && (
    route.requestOptions.temperature !== undefined ||
    route.requestOptions.topP !== undefined ||
    route.requestOptions.maxTokens !== undefined
  ));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
