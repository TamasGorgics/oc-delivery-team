import type { AgentEditor } from "@opencode/plugin/promise/agent";
import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { Registration } from "@opencode/plugin/promise/registration";
import type { Info as ToolInfo, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
import type { AgentDraft, PluginContext } from "../../src/compat";

export interface FakeModelInfo {
  readonly id: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly enabled?: boolean;
  readonly capabilities?: {
    readonly tools?: boolean;
    readonly temperature?: boolean;
  };
  readonly variants?: readonly { readonly id: string }[];
  readonly limit?: { readonly output?: number };
}

export interface FakeProviderInfo {
  readonly id: string;
  readonly activation?: "auto" | "enabled" | "disabled";
}

export interface FakeContextOptions {
  readonly options?: unknown;
  readonly projectDirectory?: string;
  readonly models?: readonly FakeModelInfo[];
  readonly providers?: readonly FakeProviderInfo[];
  readonly defaultModel?: FakeModelInfo | null;
  readonly modelListError?: Error;
  readonly providerListError?: Error;
  readonly modelDefaultError?: Error;
}

export interface FakePromptCall {
  readonly sessionID: string;
  readonly text: string;
  readonly files?: readonly unknown[];
  readonly agents?: readonly unknown[];
  readonly skills?: readonly unknown[];
  readonly delivery?: "steer" | "queue";
}

export interface FakeContextEvent {
  readonly agent: string;
  readonly model?: unknown;
  readonly options: Record<string, unknown>;
}

export interface FakeContextHarness {
  readonly context: PluginContext;
  readonly state: {
    readonly agents: Map<string, AgentDraft>;
    readonly commands: Map<string, CommandDefinition>;
    readonly tools: Map<string, ToolInfo & { readonly id: string }>;
    readonly prompts: FakePromptCall[];
    readonly switchedAgents: Array<{ sessionID: string; agent: string }>;
    readonly actions: string[];
    readonly agentTransforms: Array<(editor: AgentEditor) => void>;
    readonly toolTransforms: Array<(editor: ToolEditor) => void>;
    contextHook?: (event: FakeContextEvent) => void | Promise<void>;
    reloadCount: number;
    commandReloadCount: number;
    toolReloadCount: number;
  };
  replayAgentTransforms(): void;
  invokeCommand(name: string, text?: string): Promise<void>;
  invokeTool(name: string, input: unknown, context?: Partial<FakeToolCallContext>): Promise<{ output?: unknown; content?: unknown }>;
  invokeContextHook(agent: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface FakeToolCallContext {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
}

export function fakeModel(
  providerID: string,
  modelID: string,
  overrides: Partial<FakeModelInfo> = {},
): FakeModelInfo {
  return {
    id: `${providerID}/${modelID}`,
    providerID,
    modelID,
    enabled: true,
    capabilities: { tools: true, temperature: true },
    variants: ["low", "medium", "high"].map((id) => ({ id })),
    limit: { output: 8192 },
    ...overrides,
  };
}

export function createFakeContext(options: FakeContextOptions = {}): FakeContextHarness {
  const projectDirectory = options.projectDirectory ?? "/fake/project";
  const models = options.models ?? [fakeModel("provider", "default")];
  const providers = options.providers ?? [{ id: "provider", activation: "enabled" }];
  const defaultModel = options.defaultModel === undefined ? models[0] ?? null : options.defaultModel;

  const agents = new Map<string, AgentDraft>();
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, ToolInfo & { readonly id: string }>();
  const prompts: FakePromptCall[] = [];
  const switchedAgents: Array<{ sessionID: string; agent: string }> = [];
  const actions: string[] = [];
  const agentTransforms: Array<(editor: AgentEditor) => void> = [];
  const toolTransforms: Array<(editor: ToolEditor) => void> = [];
  const state: FakeContextHarness["state"] = {
    agents,
    commands,
    tools,
    prompts,
    switchedAgents,
    actions,
    agentTransforms,
    toolTransforms,
    contextHook: undefined,
    reloadCount: 0,
    commandReloadCount: 0,
    toolReloadCount: 0,
  };

  const editor: AgentEditor = {
    list: () => [...agents.values()],
    get: (id) => agents.get(id),
    default: () => undefined,
    update: (id, update) => {
      const draft = agents.get(id) ?? createAgentDraft(id);
      update(draft);
      agents.set(id, draft);
    },
    remove: (id) => {
      agents.delete(id);
    },
  };

  const replayAgentTransforms = (): void => {
    for (const transform of agentTransforms) transform(editor);
  };

  const registration = (dispose: () => void): Registration => ({
    dispose: async () => dispose(),
  });

  const rawContext = {
    options: options.options ?? {},
    location: { directory: projectDirectory },
    app: { name: "fake", version: "2.2.0", channel: "test" },
    agent: {
      transform: async (transform: (editor: AgentEditor) => void): Promise<Registration> => {
        agentTransforms.push(transform);
        transform(editor);
        return registration(() => {
          const index = agentTransforms.indexOf(transform);
          if (index >= 0) agentTransforms.splice(index, 1);
        });
      },
      reload: async (): Promise<void> => {
        state.reloadCount += 1;
        replayAgentTransforms();
      },
    },
    command: {
      list: async () => ({
        location: { directory: projectDirectory },
        data: [...commands.values()].map((command) => ({
          name: command.name,
          description: command.description,
        })),
      }),
      reload: async (): Promise<void> => {
        state.commandReloadCount += 1;
      },
      transform: async (transform: (editor: { add: (command: CommandDefinition) => void }) => void): Promise<Registration> => {
        const added: string[] = [];
        transform({
          add: (command) => {
            commands.set(command.name, command);
            added.push(command.name);
          },
        });
        return registration(() => {
          for (const name of added) commands.delete(name);
        });
      },
    },
    tool: {
      transform: async (transform: (editor: ToolEditor) => void): Promise<Registration> => {
        toolTransforms.push(transform);
        const added: string[] = [];
        const editor: ToolEditor = {
          list: () => [...tools.values()],
          get: (id) => tools.get(id),
          namespace: () => {},
          add: (tool) => {
            tools.set(tool.name, { ...tool, id: tool.name });
            added.push(tool.name);
          },
          update: (id, update) => {
            const tool = tools.get(id);
            if (tool) update(tool as never);
          },
          remove: (id) => {
            tools.delete(id);
          },
        };
        transform(editor);
        return {
          dispose: async () => {
            for (const name of added) tools.delete(name);
            const index = toolTransforms.indexOf(transform);
            if (index >= 0) toolTransforms.splice(index, 1);
          },
        };
      },
      list: async () => [...tools.values()],
      reload: async (): Promise<void> => {
        state.toolReloadCount += 1;
      },
      hook: async (): Promise<Registration> => registration(() => {}),
    },
    model: {
      list: async () => {
        if (options.modelListError) throw options.modelListError;
        return { location: { directory: projectDirectory }, data: [...models] };
      },
      default: async () => {
        if (options.modelDefaultError) throw options.modelDefaultError;
        return { location: { directory: projectDirectory }, data: defaultModel };
      },
    },
    provider: {
      list: async () => {
        if (options.providerListError) throw options.providerListError;
        return { location: { directory: projectDirectory }, data: [...providers] };
      },
    },
    session: {
      hook: async (name: string, handler: (event: FakeContextEvent) => void | Promise<void>): Promise<Registration> => {
        if (name !== "context") throw new Error(`Unsupported fake session hook: ${name}`);
        state.contextHook = handler;
        return registration(() => {
          if (state.contextHook === handler) state.contextHook = undefined;
        });
      },
      switchAgent: async (input: { sessionID: string; agent: string }): Promise<void> => {
        switchedAgents.push(input);
        actions.push(`switch:${input.agent}`);
      },
      prompt: async (input: FakePromptCall): Promise<void> => {
        prompts.push(input);
        actions.push("prompt");
      },
    },
  };

  const context = rawContext as unknown as PluginContext;
  return {
    context,
    state,
    replayAgentTransforms,
    async invokeCommand(name, text = "") {
      const command = commands.get(name);
      if (!command) throw new Error(`Command '${name}' is not registered.`);
      const invocation = {
        sessionID: "session-1",
        prompt: { text },
        delivery: "steer",
      } as unknown as Parameters<CommandDefinition["execute"]>[0];
      await command.execute(invocation);
    },
    async invokeTool(name, input, context = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool '${name}' is not registered.`);
      const toolContext = {
        sessionID: context.sessionID ?? "session-1",
        agent: context.agent ?? "team-lead",
        messageID: context.messageID ?? "message-1",
        id: context.id ?? "call-1",
        signal: new AbortController().signal,
        progress: async () => {},
      } as unknown as ToolContext;
      return tool.execute(input, toolContext) as Promise<{ output?: unknown; content?: unknown }>;
    },
    async invokeContextHook(agent, options = {}) {
      const event: FakeContextEvent = { agent, options };
      await state.contextHook?.(event);
      return event.options;
    },
  };
}

function createAgentDraft(id: string): AgentDraft {
  return {
    id,
    name: id,
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [],
  } as unknown as AgentDraft;
}
