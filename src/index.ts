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

export interface DeliveryTeamSnapshot {
  readonly configWarnings: readonly ConfigWarning[];
  readonly setupWarnings: readonly string[];
  readonly commands: readonly string[];
  readonly models: ModelResolution["snapshot"];
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
  const config = parseConfig(pluginOptions(context), projectDirectory(context));
  const setupWarnings: string[] = [];
  const catalog = await readModelCatalog(context);
  const modelResolution = resolveModels(config.models, catalog, config.roles.disabled);
  const disposers: Array<() => Promise<void>> = [];
  let commandNames: string[] = [];

  try {
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
      models: modelResolution.snapshot,
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
