export const ROLE_IDS = [
  "team-lead",
  "researcher",
  "spec",
  "developer",
  "tester",
  "qa",
  "adversary",
  "docs",
  "retro",
] as const;

export type RoleId = (typeof ROLE_IDS)[number];

export const MODEL_TIERS = ["reasoning", "coding", "fast"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

export type RoleMode = "primary" | "subagent";

export type WriteScope = "none" | "root" | "source" | "tests" | "docs";

export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export interface RoleDefinition {
  readonly id: RoleId;
  readonly name: string;
  readonly description: string;
  readonly mode: RoleMode;
  readonly tier: ModelTier;
  /** Undefined means no step limit. */
  readonly maxSteps?: number;
  readonly artifacts: readonly string[];
  readonly promptId: RoleId;
  readonly readOnly: boolean;
  readonly writesSource: boolean;
  readonly writeScope: WriteScope;
  readonly shell: "deny" | "allow";
  readonly toolNeeds: readonly string[];
}

const COMMON_TOOLS = ["read", "glob", "grep", "team_status", "team_note", "team_loop"] as const;

export const ROLES: readonly RoleDefinition[] = [
  {
    id: "team-lead",
    name: "Team Lead",
    description: "Orchestrates the delivery pipeline, enforces phase gates, and never writes code.",
    mode: "primary",
    tier: "reasoning",
    artifacts: [],
    promptId: "team-lead",
    readOnly: true,
    writesSource: false,
    writeScope: "none",
    shell: "deny",
    toolNeeds: [
      ...COMMON_TOOLS,
      "subagent",
      "question",
      "team_start",
      "team_advance",
      "team_rewind",
      "team_stack",
    ],
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Explores options, prior art, constraints, and risks without changing the project.",
    mode: "subagent",
    tier: "fast",
    maxSteps: 25,
    artifacts: ["brainstorm.md"],
    promptId: "researcher",
    readOnly: false,
    writesSource: false,
    writeScope: "root",
    shell: "deny",
    toolNeeds: [...COMMON_TOOLS, "webfetch", "websearch", "team_stack", "team_stack_update"],
  },
  {
    id: "spec",
    name: "Spec",
    description: "Turns the brainstorm into a specification and implementation plan.",
    mode: "subagent",
    tier: "reasoning",
    maxSteps: 20,
    artifacts: ["spec.md", "plan.md"],
    promptId: "spec",
    readOnly: false,
    writesSource: false,
    writeScope: "root",
    shell: "deny",
    toolNeeds: [...COMMON_TOOLS, "team_stack"],
  },
  {
    id: "developer",
    name: "Developer",
    description: "Implements the approved plan and records implementation notes.",
    mode: "subagent",
    tier: "coding",
    maxSteps: 80,
    artifacts: ["impl-notes.md"],
    promptId: "developer",
    readOnly: false,
    writesSource: true,
    writeScope: "source",
    shell: "allow",
    toolNeeds: [...COMMON_TOOLS, "edit", "write", "patch", "shell", "team_stack"],
  },
  {
    id: "tester",
    name: "Tester",
    description: "Writes and runs tests from the acceptance criteria without changing source.",
    mode: "subagent",
    tier: "coding",
    maxSteps: 50,
    artifacts: ["test-report.md"],
    promptId: "tester",
    readOnly: false,
    writesSource: false,
    writeScope: "tests",
    shell: "allow",
    toolNeeds: [...COMMON_TOOLS, "edit", "write", "patch", "shell", "team_stack"],
  },
  {
    id: "qa",
    name: "Quality Assurance",
    description: "Verifies behavior against the specification and records a verdict.",
    mode: "subagent",
    tier: "coding",
    maxSteps: 30,
    artifacts: ["qa.md"],
    promptId: "qa",
    readOnly: false,
    writesSource: false,
    writeScope: "root",
    shell: "allow",
    toolNeeds: [...COMMON_TOOLS, "shell", "team_stack"],
  },
  {
    id: "adversary",
    name: "Adversary",
    description: "Tries to break the implementation: bugs, edge cases, security, and spec gaps.",
    mode: "subagent",
    tier: "reasoning",
    maxSteps: 40,
    artifacts: ["adversary.md"],
    promptId: "adversary",
    readOnly: false,
    writesSource: false,
    writeScope: "root",
    shell: "allow",
    toolNeeds: [...COMMON_TOOLS, "shell", "team_stack"],
  },
  {
    id: "docs",
    name: "Docs",
    description: "Updates user-facing documentation to match the delivered behavior.",
    mode: "subagent",
    tier: "fast",
    maxSteps: 20,
    artifacts: ["docs.md"],
    promptId: "docs",
    readOnly: false,
    writesSource: false,
    writeScope: "docs",
    shell: "deny",
    toolNeeds: [...COMMON_TOOLS, "edit", "write", "patch", "team_stack"],
  },
  {
    id: "retro",
    name: "Retrospective",
    description: "Reviews the completed run and records process improvements.",
    mode: "subagent",
    tier: "reasoning",
    maxSteps: 20,
    artifacts: ["retro.md"],
    promptId: "retro",
    readOnly: false,
    writesSource: false,
    writeScope: "root",
    shell: "deny",
    toolNeeds: [...COMMON_TOOLS, "team_stack", "team_lesson_propose"],
  },
];

export const ROLE_BY_ID: Readonly<Record<RoleId, RoleDefinition>> = Object.fromEntries(
  ROLES.map((role) => [role.id, role]),
) as Record<RoleId, RoleDefinition>;

export function isRoleId(value: unknown): value is RoleId {
  return typeof value === "string" && (ROLE_IDS as readonly string[]).includes(value);
}

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);
}

export function enabledRoles(disabled: readonly RoleId[] = []): readonly RoleDefinition[] {
  const blocked = new Set(disabled);
  return ROLES.filter((role) => !blocked.has(role.id));
}

/**
 * Coarse permissions for M1. Narrow write scopes are enforced by prompts now and by
 * the Stack Profile plus gate hook in M2/M3.
 */
export function rolePermissionRules(role: RoleDefinition, rootDir: string): PermissionRule[] {
  const rules: PermissionRule[] = [];

  if (role.writeScope === "none") {
    rules.push({ action: "edit", resource: "*", effect: "deny" });
  } else if (role.writeScope === "root") {
    rules.push({ action: "edit", resource: "*", effect: "deny" });
    rules.push({ action: "edit", resource: `${rootDir}/**`, effect: "allow" });
  } else {
    // M2/M3 hooks and prompts narrow tester/docs scopes beyond this M1 allow rule.
    rules.push({ action: "edit", resource: "*", effect: "allow" });
  }

  if (role.shell === "deny") {
    rules.push({ action: "shell", resource: "*", effect: "deny" });
  } else {
    rules.push({ action: "shell", resource: "*", effect: "allow" });
  }

  return rules;
}
