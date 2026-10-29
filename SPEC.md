# Spec: `opencode-delivery-team` — a software delivery team as an OpenCode V2 plugin

Status: draft v1.1 (v1.1 adds the stack-agnostic design §6.3 and per-role model routing §6.2) · Audience: an AI coding agent (OpenCode or Claude Code) implementing this end to end · Language: TypeScript

---

## 0. How to use this document (read first)

You are implementing the plugin described below. Follow these rules:

1. **Do Phase 0 (API discovery) before writing feature code.** The OpenCode V2 plugin API is **beta**. This spec contains facts taken from the official V2 docs (marked **[DOC]**) and assumptions that were *not* confirmed (marked **[VERIFY]**). Resolve every `[VERIFY]` by reading the installed package's `.d.ts` types, the V2 docs (`https://v2.opencode.ai/build/plugins.md`, `https://v2.opencode.ai/llms.txt`), or by a throwaway experiment. Record outcomes in `docs/api-notes.md`.
2. **Never invent API surface.** If something you need does not exist in the installed types, use the documented fallback in §15, and note the deviation in `docs/api-notes.md`. If there is no fallback, stop and report.
3. **Build milestone by milestone (§17).** Each milestone has acceptance criteria. Do not start the next until the current one passes.
4. **Keep hooks cheap and safe.** A failing runtime hook fails the operation it intercepts **[DOC]**. Logging/tracing code must never throw into a hook.
5. Prefer small, tested modules over one big file. Code must typecheck in strict mode.

---

## 1. Goal

A single OpenCode plugin that gives a developer an **entire software delivery team** inside OpenCode:

- One **orchestrator** (the main/primary session, agent `team-lead`) that runs a delivery pipeline.
- A set of **specialist subagents**: researcher, spec writer, developer, tester, QA, adversary, docs writer, retro.
- A **phase-gated workflow** (brainstorm → spec → plan → implement → test → qa → adversary → docs → retro → done) that is *enforced by tools and hooks*, not just requested in prompts.
- **Observability**: every run, phase, session, tool call, gate decision, and loop is recorded in SQLite and queryable via a CLI and a status tool.
- **Learning / self-improvement**: a retro phase extracts lessons, which (after human approval) are injected into future model requests; agent prompt changes are *proposed* by the retro agent and *approved by a human*.
- **Technology-stack agnostic**: the team works on any language, framework or toolchain. Build/test/lint/run commands and file conventions come from a detected, overridable **Stack Profile** (§6.3), never from assumptions baked into code or prompts.
- **Right model per role**: each agent can use a different LLM. Defaults are expressed as capability **tiers** (not model IDs) and resolve to the host's default model when nothing is configured; everything is parameterizable (§6.2).

### Non-goals (v1)

- No fully automatic self-modification of prompts (human approval required).
- No web dashboard (CLI + SQL only). No OpenTelemetry exporter (design the schema so one can be added; JSONL export is in scope).
- No TUI plugin / custom UI panels. (The V2 docs mention TUI slots in other plugins; out of scope.)
- No multi-repo or multi-machine coordination.
- No v1-API (`@opencode-ai/plugin` v1) compatibility. V2 only.

---

## 2. Background: OpenCode V2 plugin API facts

### 2.1 Confirmed by the V2 docs **[DOC]**

Source: `https://v2.opencode.ai/build/plugins.md`

- A plugin module has **one default export** from `Plugin.define({ id, setup })`, imported from `"@opencode-ai/plugin/v2"`. `id` must be unique. `setup(ctx)` may be async and may return a (sync or async) **cleanup function**. Hook registrations are released automatically on reload/unload; use the cleanup for timers, watchers, connections.
- `setup` must not block on an infinite stream; register long-lived behavior and return.
- Config key is **`plugins`** (not `plugin`) in `opencode.json(c)`. Entries: package specifier, local path (`./` or `../`, relative to the config file), absolute path/`file://`, or object form `{ "package": "...", "options": {...} }`. `options` is passed unchanged as `ctx.options` (empty object if omitted). **The plugin owns option validation and defaults.**
- **Local discovery:** `.opencode/plugins/` (project) and `~/.config/opencode/plugins/` (global). Direct `.ts`/`.js` children load; an immediate child directory loads as a package if it has a string `exports`/`module`/`main` or an `index.ts|js`. A `plugins/` dir beside a project-root `opencode.json` is **not** auto-discovered.
- **Dependencies:** npm-installed plugins get production deps installed into an isolated cache (no lifecycle scripts). **Local files/dirs do not get dependencies installed**; install them in a `package.json` visible from the plugin file (e.g. `cd .opencode && bun add @opencode-ai/plugin@next`).
- Disable/enable by plugin `id` via config strings starting with `-`.
- Config and discovered plugin files are hot-reloaded on change (new plugin "generation"). Restart after changing an npm package version or a non-watched local dependency.
- Hooks run sequentially in registration order; later hooks see earlier mutations.
- **Context (`ctx`) capabilities:**

  | Capability | Operations |
  |---|---|
  | `ctx.agent` | `list`, `transform`, `reload` |
  | `ctx.catalog.provider` / `.model` / `.transform` / `.reload` | provider/model listing, default model, transform |
  | `ctx.command` | `list`, `transform`, `reload` |
  | `ctx.integration` | list/get/connect/attempt/transform/reload |
  | `ctx.plugin` | `list` active plugin IDs |
  | `ctx.reference` | `list`, `transform`, `reload` |
  | `ctx.session` | `create`, `get`, `prompt`, `command`, `interrupt`, `hook` |
  | `ctx.skill` | `list`, `transform`, `reload` |
  | `ctx.tool` | `transform`, `hook` |
  | `ctx.aisdk` | `hook` |
  | `ctx.event` | `subscribe` to the public server event stream |
  | `ctx.options` | readonly plugin options |

- **Transforms** mutate configuration via a "draft": `agent.transform((agents) => agents.update(name, (agent) => { agent.description = ...; agent.mode = "subagent" }))`. `agent.transform` draft ops: `list, get, default, update, remove`. `command.transform`: `list, get, update, remove` with `command.description` / `command.template`. `tool.transform`: `add`.
- **Runtime hooks** (mutable fields): `ctx.session.hook("request", cb)` → `system`, `messages`, `tools` (record) immediately before model dispatch; `ctx.tool.hook("execute.before", cb)` → `input`; `ctx.tool.hook("execute.after", cb)` → `result`, `output`, `outputPaths`. Event objects for tool hooks expose at least `event.tool` and `event.input`.
- **Adding a tool:**
  ```ts
  await ctx.tool.transform((tools) => {
    tools.add({
      name: "greeting",
      description: "Create a greeting",
      jsonSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      execute: async ({ name }, toolCtx /* { sessionID, agent, assistantMessageID, toolCallID } */) => ({
        structured: { greeting: `Hello, ${name}!` },
        content: [{ type: "text", text: `Hello, ${name}!` }],
      }),
    })
  })
  ```
  Tool/group names are normalized (invalid chars → `_`); exposed key must start with a letter, ≤64 chars of letters/digits/`_`/`-`. `options: { group, deferred }` are available on the declaration. The executor's second argument carries `sessionID`, `agent`, `assistantMessageID`, `toolCallID`.
- A hook failure fails the intercepted operation → throwing inside `execute.before` **blocks** the tool call.
- Verify loading: `opencode2 api get /api/plugin` lists active plugin IDs. Server logs show invalid modules and setup failures.
- An Effect-based entrypoint exists (`@opencode-ai/plugin/v2/effect`); **this project uses the plain Promise entrypoint.**

### 2.2 Package naming caveat

The official V2 docs use `@opencode-ai/plugin` (install tag `next`, entrypoint `/v2`). Some community repos mention `@opencode/plugin`. **Use whichever the installed OpenCode release resolves; default to the official docs.** Pin exact versions in `package.json` once working.

---

## 3. Architecture overview

```
┌────────────────────────── OpenCode (V2 host) ───────────────────────────┐
│  team-lead (primary agent)                                              │
│     │ delegates via built-in task tool                                  │
│     ▼                                                                   │
│  researcher │ spec │ developer │ tester │ qa │ adversary │ docs │ retro │
│                                                                         │
│  Plugin "delivery-team"                                                 │
│   ├─ agent.transform     → registers the 9 agents + prompts             │
│   ├─ command.transform   → /team, /team-status, /team-retro             │
│   ├─ tool.transform      → team_* tools (state machine, notes, loops)   │
│   ├─ tool.hook before    → phase/permission gating, loop caps           │
│   ├─ tool.hook after     → tracing                                      │
│   ├─ session.hook request→ lesson injection (+ trace of requests)       │
│   └─ event.subscribe     → session tree + message tracing [VERIFY]      │
└───────────────┬─────────────────────────────────────────────────────────┘
                │ reads/writes
   ┌────────────▼─────────────┐     ┌──────────────────────────────┐
   │ SQLite (.team/team.db)   │     │ Files (.team/…)              │
   │ runs, phases, sessions,  │     │ runs/<run>/*.md  artifacts   │
   │ tool_calls, loops,       │     │ prompts/*.md  approved       │
   │ lessons(+FTS), proposals,│     │ proposals/*.md  pending      │
   │ evals                    │     └──────────────────────────────┘
   └──────────────────────────┘
   CLI `team` (human-only): approve/reject lessons & prompts, report, export, eval
```

**Principles**

- **Handoff by file, not by chat.** Agents pass *paths*, never content, to keep context small. Artifacts live in `.team/runs/<run>/` (human-readable, diffable).
- **Machine state in SQLite; human artifacts as files.**
- **Enforcement by tools/hooks**, prompts only guide.
- **Humans approve changes to future behavior** (lessons and prompts). Agents can *propose* but have no tool that approves.
- **Stack-agnostic by construction.** No language/framework/tool names in plugin logic or default prompts; the Stack Profile (§6.3) is the single source of truth for "how to build, test and run this project".
- **Models are configuration, not code.** Roles map to tiers; tiers map to models via options; with no options every role inherits the host default (§6.2).

---

## 4. Repository layout

```
opencode-delivery-team/
  package.json                 # type: module; exports: ./src/index.ts; bin: { team: ./src/cli/team.ts }
  tsconfig.json                # strict
  README.md
  docs/
    api-notes.md               # Phase 0 output: resolved [VERIFY] items
    architecture.md            # brief, generated from §3
  src/
    index.ts                   # default export Plugin.define(...)
    config.ts                  # option parsing/validation/defaults
    roles.ts                   # role table (name, mode, readOnly, tools, default prompt id, default model tier)
    models.ts                  # model routing: tiers, resolution, validation, fallbacks (§6.2)
    stack/
      detect.ts                # pure, table-driven stack detection (§6.3)
      markers.ts               # data table: ecosystem markers -> profile fragments
      profile.ts               # schema, validation, merge, resolution order
    prompts/                   # default prompts as .ts string exports (one file per role)
    state/
      db.ts                    # SQLite adapter (bun:sqlite | node:sqlite), migrations
      schema.ts                # DDL + migration list
      runs.ts                  # run/phase/session repositories
      lessons.ts               # lessons repo + FTS queries
      trace.ts                 # safe tracing API (never throws)
      artifacts.ts             # artifact path helpers + footer parsing
    tools/
      start.ts status.ts advance.ts rewind.ts note.ts loop.ts lesson.ts worktree.ts stack.ts
    hooks/
      gate.ts                  # tool.execute.before
      trace-after.ts           # tool.execute.after
      inject-lessons.ts        # session request hook
      events.ts                # event subscription [VERIFY]
    commands.ts                # slash commands
    cli/
      team.ts                  # human CLI (see §12)
  test/
    unit/…                     # per-module tests
    fakes/ctx.ts               # fake plugin ctx used by tests
    integration/…              # headless OpenCode tests (if available)
  evals/
    tasks/<name>/{task.md,fixture/,criteria.json}
    run.ts
```

Runtime data directory (default `.team/`, configurable, **gitignore `team.db*`**, but commit `prompts/`, `lessons-export/`):

```
.team/
  team.db  (+ -wal, -shm)
  runs/<run-id>/            # artifacts for one run
  prompts/<role>.md         # human-approved prompt overrides
  proposals/<role>.<ts>.md  # retro-proposed prompt overrides (pending)
  lessons-export/*.md       # periodic markdown export of approved lessons
```

---

## 5. Configuration (`ctx.options`)

Validate by hand (or with `zod` listed in `dependencies`); unknown keys → warning in trace, not failure. All optional.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `root` | string | `".team"` | Data dir, resolved against the project directory |
| `dbPath` | string | `<root>/team.db` | SQLite file |
| `maxLoops` | int | `3` | Max fix/review loops per (run, phase) before escalation |
| `lessons.topN` | int | `8` | Max lessons injected per request |
| `lessons.budgetChars` | int | `4000` | Hard char cap on injected lesson text |
| `models` | object | `{}` (everything inherits the host default) | Model routing: tiers, per-role overrides, params, fallbacks. See §6.2 |
| `stack` | object | `{}` | Stack profile detection and overrides: `{ detect?: bool (default true), overrides?: partial profile }`. See §6.3 |
| `roles.disabled` | string[] | `[]` | Roles to not register |
| `gating.enabled` | bool | `true` | Enforce phase gating |
| `gating.strict` | bool | `false` | If run/phase can't be resolved for a tool call: `true` → block, `false` → allow + trace `gate.unresolved` |
| `gating.editTools` | string[] | `["edit","write","patch"]` | Tool names treated as source edits **[VERIFY names]** |
| `trace.captureInput` | bool | `false` | Store tool input (privacy default: store size + tool name only) |
| `trace.previewChars` | int | `0` | If >0 store a truncated preview of tool output |
| `worktrees.enabled` | bool | `false` | Enable `team_worktree` tool |
| `worktrees.baseDir` | string | `"../.team-worktrees"` | Where git worktrees are created |

Example config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "opencode-delivery-team", "options": { "maxLoops": 3, "worktrees": { "enabled": true } } }
  ]
}
```

The plugin `id` is `delivery-team`.

---

## 6. Roles (agents)

Registered in `setup` through `ctx.agent.transform` **[DOC]**. Each agent: `description`, `mode`, prompt, permissions. Prompt field name and permission shape are **[VERIFY]** (v1 used `prompt` and `permission: { edit, bash }`).

| Role | Mode | Writes source? | Bash? | Primary artifact | Purpose |
|---|---|---|---|---|---|
| `team-lead` | primary | no | no | — | Orchestrates; never writes code |
| `researcher` | subagent | no | no (web/read only) | `brainstorm.md` | Options, prior art, risks |
| `spec` | subagent | no (only `.team/`) | no | `spec.md`, `plan.md` | Specification + implementation plan |
| `developer` | subagent | **yes** | yes | `impl-notes.md` | Implements the plan (own worktree if enabled) |
| `tester` | subagent | tests only | yes | `test-report.md` | Writes + runs tests from acceptance criteria; must not change `src` |
| `qa` | subagent | no | read-only cmds | `qa.md` | Verifies behavior vs spec |
| `adversary` | subagent | no | read-only cmds | `adversary.md` | Tries to break it: bugs, edge cases, security, spec gaps |
| `docs` | subagent | docs only | no | `docs.md` | Updates README/docs |
| `retro` | subagent | `.team/` only | no | `retro.md` | Extracts lessons; proposes prompt changes |

Rules:

- Read-only roles get `edit: deny`, `bash: deny` (or the closest equivalent). Roles that need narrow write access are constrained by the gate hook (§9) *and* prompt.
- Default prompts live in `src/prompts/<role>.ts`. **Prompt resolution order** at setup: (1) `.team/prompts/<role>.md` if present (human-approved), else (2) the built-in default. After approving a prompt, `ctx.agent.reload()` **[DOC: exists]** re-applies transforms; also reload on setup.
- All role prompts must: state the role's single responsibility; name the artifact(s) to write and their required **machine-readable footer** (§7.3); say "pass paths, not content"; say "do not exceed your scope"; tell the agent to call `team_note` for decisions/findings and `team_loop` before retrying.
- `team-lead` prompt must encode the pipeline, the loop cap rule, "ask the human after `maxLoops`", and "call `team_advance` only after the phase artifact exists and the footer is satisfied".
- Do not hardcode model IDs anywhere in code or default prompts. Model selection is governed solely by §6.2.
- Default prompts must be language/framework-neutral and must use the Stack Profile (§6.3) for any project-specific command or path.

### 6.2 Model routing (per-role LLMs)

**Goals:** each role may use a different model; sane defaults with zero configuration; fully parameterizable; never hardcode model IDs.

**Tiers.** Defaults are expressed as capability tiers, not model IDs:

| Tier | Meaning | Default roles | Default params (applied only if the model supports them **[VERIFY V14]**) |
|---|---|---|---|
| `reasoning` | Strongest planning/critique model | `team-lead`, `spec`, `adversary`, `retro` | `reasoningEffort: "high"` |
| `coding` | Strong, reliable tool-using code model | `developer`, `tester`, `qa` | `reasoningEffort: "medium"` |
| `fast` | Cheap and quick | `researcher`, `docs` | none |

Default `maxSteps` per role (overridable; field name **[VERIFY V14]**): team-lead unlimited, researcher 25, spec 20, developer 80, tester 50, qa 30, adversary 40, docs 20, retro 20.

**Resolution order per role (first match wins):**

1. `models.roles.<role>`: a string `provider/model` or an object `{ model, params?, fallback?: string[] }`.
2. `models.tiers.<tier>` for the role's tier (the same string/object forms).
3. `models.default`.
4. **Inherit** the host's default model (leave the agent's model unset; `ctx.catalog.model.default` **[DOC: op exists]** can be used for reporting).

With no configuration every role inherits the host default and everything works. Routing is opt-in.

**Options schema** (`options.models`):

```jsonc
{
  "default": "provider/model",                          // optional
  "tiers": { "reasoning": <spec>, "coding": <spec>, "fast": <spec> },
  "roles": { "<role>": <spec> },                        // overrides tiers
  "roleTier": { "<role>": "reasoning|coding|fast" },    // move a role to another tier
  "params": { "<role>": { /* merged over defaults */ } },
  "diversity": true,                                    // see below
  "auto": false                                         // stretch: auto-assign tiers from catalog metadata
}
// <spec> = "provider/model" | { "model": "provider/model", "params": {...}, "fallback": ["provider/model", ...] }
```

**Params** (pass-through; validated key set): `temperature`, `topP`, `reasoningEffort` (or the provider's equivalent variant), `maxSteps`, `maxOutputTokens`. Unknown keys produce a warning event and are ignored. Params the chosen model does not support are dropped and traced once.

**Validation (at setup, never fatal).** For every resolved model, check through `ctx.catalog.model.list` / `ctx.catalog.provider.list` **[DOC: ops exist; shapes VERIFY V14]** that the model exists, its provider is connected/available, and it supports tool calling (required for every role). On failure walk `fallback` → the tier spec → `models.default` → inherit, writing `events` rows `model.fallback` with the reason. A bad model config must never stop the plugin from loading.

**Diversity.** Independent review is the point of the `adversary` and `qa` roles. When `diversity` is true (default) and `adversary` resolves to the same model as `developer`, emit `model.diversity_warning` and show it in `team_status` and `team report`. The plugin never silently swaps models.

**Auto (stretch, default off).** If `auto: true` and catalog metadata (capabilities, cost, context limit) is available: `reasoning` = most capable tool-capable model, `fast` = cheapest tool-capable model, `coding` = the host default; only from connected providers. If metadata is missing, log and fall back to inherit.

**Applying.** Set model and params on each agent inside `ctx.agent.transform` (draft field names **[VERIFY V13, V14]**). Config hot-reload re-runs `setup` **[DOC]**, so model changes need no code change.

**Reproducibility and cost.** At `team_start`, snapshot the resolution into `run_models` (role, model or NULL for inherit, params, `source`). If events are available, `messages` records actual model/tokens/cost; `team report` groups cost and loop counts by role and model; evals record a `model_set_sha` so prompt and model changes can be compared (§14).

**Docs.** The README shows illustrative presets ("single model", "reasoning + cheap", "cross-provider adversary") with placeholder IDs, clearly marked as examples and never used as code defaults.

### 6.3 Technology-stack agnosticism

1. **No assumptions.** Plugin code and default prompts must not assume a language, framework, package manager, test runner, CI system, VCS host or OS. The only hard requirement is a project directory. Git is optional (needed only for worktrees, §13).
2. **Stack Profile** is the single source of truth for how to build, test and run the project. Schema:

   ```json
   {
     "version": 1,
     "source": "detected | researcher | human",
     "components": [{
       "name": "api", "root": ".",
       "languages": ["go"], "frameworks": [], "packageManager": "go",
       "commands": { "install": "go mod download", "build": "go build ./...", "test": "go test ./...",
                     "lint": null, "format": null, "typecheck": null, "run": null },
       "globs": { "source": ["**/*.go"], "tests": ["**/*_test.go"], "docs": ["README*", "docs/**"], "ignore": ["vendor/**"] }
     }],
     "notes": "free text from the researcher"
   }
   ```

   Commands are verbatim strings or `null`. **The plugin never executes profile commands itself**; agents run them with their own tools. Detection is side-effect free (file listing plus a few small file reads; no command execution, no network). The example values above are illustrative only.
3. **Resolution order (first wins):** `<root>/stack.json` (human-owned) → `options.stack.overrides` → the profile stored on the run (researcher-confirmed) → auto-detected → empty profile. With an empty profile, agents must discover the commands themselves and record them via `team_stack_update`.
4. **Auto-detection** (`src/stack/detect.ts`, `src/stack/markers.ts`) is a pure function over a file listing and small file reads, driven by an **extensible data table** (adding an ecosystem = adding a row, not a code branch). The table must cover at least: JS/TS (`package.json`, npm/yarn/pnpm/bun lockfiles, `tsconfig.json`), Python (`pyproject.toml`, `requirements*.txt`, `setup.py`, `Pipfile`, `poetry.lock`, `uv.lock`), Go (`go.mod`, `go.work`), Rust (`Cargo.toml`), JVM (`pom.xml`, `build.gradle`, `build.gradle.kts`), .NET (`*.sln`, `*.csproj`), Ruby (`Gemfile`), PHP (`composer.json`), Elixir (`mix.exs`), Swift (`Package.swift`), C/C++ (`CMakeLists.txt`, `meson.build`), Dart/Flutter (`pubspec.yaml`), plus task runners and tooling (`Makefile`, `justfile`, `Taskfile.yml`, `package.json` scripts, `Dockerfile`, `docker-compose*`, `flake.nix`). Prefer commands the repo declares itself (scripts, Makefile/just/Task targets, CI config) over ecosystem defaults. Detect monorepos (workspace files, multiple manifests) as multiple `components`.
5. **Tools:** `team_stack` returns the resolved profile (detecting if none stored); `team_stack_update` patches it (§8).
6. **Agent behavior (put in every relevant prompt):** call `team_stack` before running any build/test/lint command; use only commands from the profile, or discover and record them. The `researcher` confirms or corrects the profile during `brainstorm` by reading README and CI configuration and records corrections with `team_stack_update`. The `tester` takes its test command from the profile; the test report footer records `COMMAND` and `EXIT` (§7.3).
7. **Gate scope uses profile globs** (§9.1): `tester` may edit paths matching `globs.tests`; `docs` paths matching `globs.docs`. If the profile has no globs, fall back to these cross-language defaults and trace `gate.scope_default`: tests `**/*_test.*`, `**/*.test.*`, `**/*.spec.*`, `**/test_*.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/*Test.java`, `**/*Tests.cs`; docs `README*`, `docs/**`, `**/*.md`.
8. **Prompts stay neutral.** They reference the Stack Profile and never name a toolchain, except inside blocks clearly labeled as examples. A unit test scans `src/prompts/**` for a denylist of stack-specific tokens (for example `npm `, `pytest`, `go test`, `cargo`, `mvn`, `gradle`, `dotnet`) outside labeled example blocks and fails on any hit.
9. **Lessons carry a `stack_tag`** (a language id from the profile, or `*`). Injection filters on the run's profile languages (§9.3). `team_lesson_propose` accepts an optional `stack`, default `*`.
10. **Projects without tests** (infrastructure, docs-only, config repos): if `commands.test` is `null`, the `tester` may write `RESULT: SKIPPED` with the rationale in `test-report.md`. The gate accepts `SKIPPED` only when the profile has no test command **and** a `team_note(kind="decision")` for the run explains why. Otherwise `SKIPPED` is denied.
11. **OS neutrality.** Use `node:path` for all path handling; nothing OS-specific in plugin logic. Commands are shell strings, and the profile may include an optional `shell` hint. Windows is not a v1 target but must not be precluded.

---

## 7. Workflow & state machine

### 7.1 Phases (ordered)

`brainstorm → spec → plan → implement → test → qa → adversary → docs → retro → done`

### 7.2 Required artifacts to *leave* a phase

Artifacts live at `<root>/runs/<run>/`.

| Phase | Required to leave | Footer condition (§7.3) |
|---|---|---|
| brainstorm | `brainstorm.md` | — |
| spec | `spec.md` | `STATUS: APPROVED` *(human or lead sets; see §7.4)* |
| plan | `plan.md` | — |
| implement | `impl-notes.md` | — |
| test | `test-report.md` | `RESULT: PASS` and `EXIT: 0` (or `RESULT: SKIPPED`, see §6.3 item 10) |
| qa | `qa.md` | `VERDICT: PASS` |
| adversary | `adversary.md` | `BLOCKERS: 0` |
| docs | `docs.md` | — |
| retro | `retro.md` | — |

### 7.3 Machine-readable footer

Each gated artifact ends with a footer block on its own lines, parsed by `artifacts.ts` (case-sensitive keys, last occurrence wins):

```
<!-- team-footer -->
RESULT: PASS
<!-- /team-footer -->
```

Keys by artifact: `STATUS` (spec); `RESULT` ∈ `PASS|FAIL|SKIPPED`, `COMMAND` (the exact test command run, taken from the Stack Profile) and `EXIT` (integer exit code) (test-report); `VERDICT` (qa); `BLOCKERS` (adversary, integer). The gate cross-checks that `RESULT: PASS` implies `EXIT: 0`. Missing footer when required ⇒ gate denies with a clear message naming the file and expected line.

### 7.4 Spec approval

`spec.md` footer `STATUS: APPROVED` can be set by `team-lead` **only after asking the human** (the lead prompt mandates a question to the human). The plugin cannot verify human approval; v1 relies on the prompt plus tracing a `human_approval` note via `team_note(kind="decision")`. (Future: approval via CLI.)

### 7.5 Transitions

- **Forward:** `team_advance` moves exactly one phase forward, only if the gate passes.
- **Backward:** `team_rewind(to, reason)` moves to an earlier phase (typically `implement`) after a FAIL result. Each rewind increments the loop counter for the phase being re-entered; if it exceeds `maxLoops` the tool refuses with `ESCALATE_TO_HUMAN` and records `loop.exceeded`.
- `done` is terminal; run status becomes `closed`.
- Runs also have a status: `open | blocked | closed | aborted`.

### 7.6 Run/session binding

- `team_start` binds the calling `sessionID` (from the executor's second argument **[DOC]**) as the run's `lead_session_id`.
- Tools that take `run` accept it optionally. Resolution order: explicit `run` arg → run bound to the calling session → run bound to the calling session's parent (via `sessions` table, populated from events **[VERIFY]**) → the single open run in this project → ambiguous/none.
- Gate hooks may not have a session ID **[VERIFY]**; see `gating.strict` (§5) for unresolved behavior.

---

## 8. Tools (registered via `ctx.tool.transform` → `tools.add`)

All tools: JSON-schema input with `additionalProperties: false`; return `{ structured, content: [{type:"text", text}] }`. Expected failures return an error-shaped text result (`ok:false` in `structured`) rather than throwing, so the model can react. Names below are the exposed names.

| Tool | Input | Behavior |
|---|---|---|
| `team_start` | `{ title: string, description?: string }` | Create run (`<base36-ts>-<slug>`), create dir, bind session, phase=`brainstorm`, trace `run.start`. Returns run id + artifact dir. |
| `team_status` | `{ run?: string }` | Phase, required artifact + footer status, loop counters, open lessons count, last N trace events. |
| `team_advance` | `{ run?: string }` | Check §7.2 gate; on pass move forward, record phase transition + duration; on fail return reason, trace `gate.denied`. |
| `team_rewind` | `{ run?: string, to: Phase, reason: string }` | §7.5. Enforces loop cap. |
| `team_loop` | `{ run?: string, reason: string }` | Increment/check retry counter for the current phase; returns remaining loops or `ESCALATE_TO_HUMAN`. Agents call it before any retry. |
| `team_note` | `{ run?: string, kind: "decision"\|"finding"\|"risk"\|"question", text: string }` | Append to `notes` table with caller `agent` and `sessionID`. |
| `team_lesson_propose` | `{ run?: string, role: string, text: string, evidence?: string, stack?: string }` | Insert lesson with `status='proposed'`. **There is deliberately no agent-callable approve tool.** |
| `team_worktree` | `{ run?: string, name: string }` | Only if `worktrees.enabled`. Run `git worktree add <baseDir>/<run>-<name> -b team/<run>/<name>`; return path. Never deletes. Validate `name` against `^[a-z0-9-]{1,40}$`. Uses `child_process` with an args array (no shell interpolation). |

Stack tools (§6.3):

| Tool | Input | Behavior |
|---|---|---|
| `team_stack` | `{ run?: string, refresh?: boolean }` | Return the resolved Stack Profile; run detection if none is stored or `refresh` is set; persist to `runs.stack_json` and `<run>/stack.json`. |
| `team_stack_update` | `{ run?: string, patch: object }` | JSON-merge-patch validated against the profile schema; sets `source: "researcher"`; traced. Refuses (with an explanation) to override fields defined by the human-owned `<root>/stack.json`. |

Executor context (`sessionID`, `agent`, `toolCallID`) must be persisted on every tool-originated trace row.

---

## 9. Hooks

### 9.1 `ctx.tool.hook("execute.before")` — gate (`hooks/gate.ts`)

Order of checks; any failure throws `Error` with a message that tells the agent exactly what to do next:

1. If `gating.enabled=false` → return.
2. Always trace `tool.before` (non-blocking, never throws).
3. **Edit gate:** if `event.tool ∈ gating.editTools` and the resolved run's phase index < `implement` and the target path (from `event.input` — key name **[VERIFY]**, e.g. `filePath`) is **outside** `<root>/` → throw: *"Source edits are blocked during '<phase>'. Finish the spec/plan and call team_advance."*
4. **Scope gate (best effort, needs the calling agent name — [VERIFY] whether the event carries it):** path rules come from the run's Stack Profile globs (§6.3 item 7), not from hardcoded patterns. `tester` may only edit paths matching `globs.tests`; `docs` only paths matching `globs.docs`; `retro` and `spec` only under `<root>/`. With no profile globs use the cross-language defaults and trace `gate.scope_default`. If the agent name is unavailable, skip and rely on prompts/permissions (trace `gate.scope_skipped` once per run).
5. **Loop cap:** nothing here; loop caps are enforced by `team_loop` / `team_rewind`.
6. Unresolved run/phase → `gating.strict ? throw : allow + trace('gate.unresolved')`.

### 9.2 `ctx.tool.hook("execute.after")` — trace (`hooks/trace-after.ts`)

Insert `tool_calls` row: tool, agent/session if available **[VERIFY]**, run (if resolved), duration (from matching `before` by `toolCallID` if exposed **[VERIFY]**, else `NULL`), output size in bytes, `ok` flag, optional preview (`trace.previewChars`), optional input (`trace.captureInput`). Wrap everything in try/catch.

### 9.3 `ctx.session.hook("request")` — lesson injection (`hooks/inject-lessons.ts`)

Before model dispatch, append a system section:

```
## Team lessons (approved, from past retros)
- [<role>] <lesson text>
...
```

Selection (see §11): approved lessons only; filter to the current agent's role plus `role='*'`, and to `stack_tag` in (languages of the run's Stack Profile ∪ `'*'`); rank by FTS5 BM25 against the active run's title + spec summary (fallback: recency + hit count); cap by `lessons.topN` and `lessons.budgetChars`; increment `hit_count`; trace which lesson IDs were injected. `event.system` type (string vs string[]) is **[VERIFY]** — support both. If the agent/role of the request is unavailable **[VERIFY]**, inject role-agnostic top lessons only. Never throw: on error inject nothing.

### 9.4 `ctx.event.subscribe` — sessions & messages (`hooks/events.ts`) **[VERIFY]**

Signature and event shapes are undocumented in the V2 plugin page. In Phase 0 discover: how to subscribe (callback vs async iterator), event names for session created/idle/error and message completion (tokens/cost fields), and whether child sessions expose `parentID`. If available: maintain `sessions(id, parent_id, agent, run_id, started_at, ended_at)` and per-message token/cost into `messages`. If not available: skip; derive sessions from tool executor contexts only. **Do not block `setup`** on the stream **[DOC]**; start it in the background and stop it in the returned cleanup.

### 9.5 Commands (`ctx.command.transform`) **[DOC]**

| Command | Template intent |
|---|---|
| `/team <goal>` | Tell the lead to call `team_start` and run the pipeline for `<goal>` |
| `/team-status` | Call `team_status` and summarize |
| `/team-retro` | Run the retro phase on the current run |

---

## 10. SQLite layer

### 10.1 Driver abstraction (`state/db.ts`)

Interface: `exec(sql)`, `run(sql, params)`, `get<T>(sql, params)`, `all<T>(sql, params)`, `transaction(fn)`, `close()`.

Adapters, chosen at runtime: **`bun:sqlite`** if `typeof Bun !== "undefined"`, else **`node:sqlite`** (Node ≥ 22). **[VERIFY]** the plugin host runtime in Phase 0 and record it. **No native npm modules** (no `better-sqlite3`) — local plugin deps aren't auto-installed and native builds are fragile.

On open: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;`. One DB file per project root (parallel worktrees must point at the *same* absolute path — resolve `root` against the **main** repo dir, not a worktree; use `git rev-parse --git-common-dir` to find it). Keep transactions short. Migrations via a `schema_migrations` table with ordered, idempotent steps.

### 10.2 Schema (migration 1)

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','blocked','closed','aborted')),
  phase TEXT NOT NULL, lead_session_id TEXT,
  project_dir TEXT NOT NULL, stack_json TEXT, created_at TEXT NOT NULL, closed_at TEXT
);

CREATE TABLE run_models (        -- resolved model routing snapshot taken at team_start (§6.2)
  run_id TEXT NOT NULL REFERENCES runs(id), role TEXT NOT NULL,
  model TEXT, params_json TEXT,  -- model NULL = inherit the host default
  source TEXT NOT NULL CHECK (source IN ('role','tier','default','inherit','fallback')),
  PRIMARY KEY (run_id, role)
);

CREATE TABLE phase_transitions (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  from_phase TEXT, to_phase TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('advance','rewind','start')),
  reason TEXT, at TEXT NOT NULL
);

CREATE TABLE loops (
  run_id TEXT NOT NULL REFERENCES runs(id), phase TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, phase)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, parent_id TEXT, run_id TEXT REFERENCES runs(id),
  agent TEXT, started_at TEXT, ended_at TEXT
);

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY, run_id TEXT, session_id TEXT, agent TEXT,
  tool_call_id TEXT, tool TEXT NOT NULL, phase TEXT,
  started_at TEXT, duration_ms INTEGER, ok INTEGER,
  output_bytes INTEGER, input_json TEXT, output_preview TEXT
);
CREATE INDEX idx_tool_calls_run ON tool_calls(run_id, started_at);

CREATE TABLE events (            -- gate decisions, loop events, misc trace
  id INTEGER PRIMARY KEY, run_id TEXT, at TEXT NOT NULL,
  kind TEXT NOT NULL,            -- e.g. gate.denied, gate.unresolved, loop.exceeded, lessons.injected
  data_json TEXT
);

CREATE TABLE messages (          -- only if event stream supports it
  id TEXT PRIMARY KEY, session_id TEXT, run_id TEXT, agent TEXT, model TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cost REAL, at TEXT
);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL, text TEXT NOT NULL, agent TEXT, session_id TEXT, at TEXT NOT NULL
);

CREATE TABLE lessons (
  id INTEGER PRIMARY KEY, role TEXT NOT NULL,       -- role name or '*'
  text TEXT NOT NULL, evidence TEXT, source_run TEXT,
  stack_tag TEXT NOT NULL DEFAULT '*',   -- language id from the Stack Profile, or '*'
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','retired','rejected')),
  hit_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE VIRTUAL TABLE lessons_fts USING fts5(text, content='lessons', content_rowid='id');
-- plus triggers keeping lessons_fts in sync on INSERT/UPDATE/DELETE

CREATE TABLE prompt_versions (
  id INTEGER PRIMARY KEY, role TEXT NOT NULL, sha TEXT NOT NULL, path TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','superseded')),
  source_run TEXT, created_at TEXT NOT NULL, decided_at TEXT
);

CREATE TABLE eval_runs (
  id INTEGER PRIMARY KEY, task TEXT NOT NULL, prompt_set_sha TEXT, model_set_sha TEXT, stack TEXT, started_at TEXT NOT NULL,
  score REAL, details_json TEXT
);
```

`state/trace.ts` exposes `trace.event(kind, data)`, `trace.toolCall(row)`; both swallow and log (to stderr / `events` as `trace.error`) any DB error.

---

## 11. Learning & self-improvement

### 11.1 Flow

1. `retro` phase: the retro agent reads `trace` data (via `team_status` output and the CLI-generated `report.md` placed in the run dir by `team_advance` entering `retro`), the run's artifacts, and human corrections noted via `team_note`.
2. It writes `retro.md` (what worked, what failed, loops used, gate denials, adversary findings that tests missed).
3. It calls `team_lesson_propose` for each durable lesson (short, imperative, role-scoped, with evidence).
4. For prompt changes it writes a **complete proposed prompt** to `<root>/proposals/<role>.<timestamp>.md` and the plugin records a `prompt_versions` row (`proposed`) — either by a hook on edits under `proposals/` or by `team_advance` out of `retro` scanning the directory.
5. **Human approval only** via CLI (§12): `team lessons approve <id>` / `team prompts approve <role>.<ts>` (moves the file to `<root>/prompts/<role>.md`, marks previous `superseded`, and writes a `reload` marker file the plugin watches to call `ctx.agent.reload()`; if watching isn't practical, the change applies on next OpenCode restart — document this).
6. Approved lessons are injected per §9.3.

### 11.2 Lesson quality rules (enforced in `team_lesson_propose` validation)

Length 20–300 chars; must be actionable (imperative sentence); must include `role`; reject duplicates via FTS similarity (> threshold → return existing ID); cap proposals per run (default 10).

### 11.3 Retirement

Lessons with `hit_count` high but no approving evidence in later runs may be flagged by `team lessons stale` (report only; humans retire).

---

## 12. CLI (`team`, human-only, `src/cli/team.ts`)

Run with `bunx team …` / `node` per runtime. Reads `<root>` from `--root` or `.team`. All commands operate on the same DB.

| Command | Function |
|---|---|
| `team runs [--open]` | List runs with phase, status, age |
| `team report <run>` | Per-phase durations, loops, gate denials, tool counts by tool/agent, notes, token/cost grouped by role and model if available; writes Markdown to stdout |
| `team models [--run <id>]` | Show the resolved model routing (role, model, params, source, fallbacks, diversity warnings); with `--run` show the snapshot stored in `run_models` |
| `team stack [<run>]` | Show the resolved Stack Profile and where each part came from (`human`, `override`, `researcher`, `detected`) |
| `team trace <run> [--jsonl]` | Dump trace (tool calls + events) as JSONL |
| `team lessons [--status proposed]` | List lessons |
| `team lessons approve\|reject\|retire <id>` | Change lesson status (+ `decided_at`) |
| `team lessons export` | Write approved lessons to `<root>/lessons-export/<role>.md` |
| `team prompts list` / `approve <file>` / `reject <file>` / `diff <file>` | Manage prompt proposals |
| `team eval run [task...]` / `team eval report` | §14 |
| `team db migrate` | Apply pending migrations |

Agents must have **no** way to invoke these (they are not tools). Note in docs: agents with `bash` permission could technically run the CLI; therefore the `developer`/`tester` prompts forbid it, and `gate.ts` should additionally block `bash` commands whose command string contains `team lessons approve|team prompts approve` **[VERIFY: bash tool name and input key]**.

---

## 13. Parallelism & worktrees

- With `worktrees.enabled`, `team-lead` may run several `developer` subagents in parallel, each told to call `team_worktree` first and work only inside that path.
- Merge strategy: the lead (not developers) integrates branches in the `implement` phase and records a `decision` note. Conflicts → `team_loop`.
- All agents in all worktrees share one DB (§10.1). Verify with a concurrency test (§16).
- Worktrees require a git repository. In a non-git project `team_worktree` returns an error and `team-lead` runs developers sequentially in place.
- v1 does not clean up worktrees; `team runs` shows leftover worktrees (`git worktree list`) for manual removal.

---

## 14. Evals (milestone 6, can ship after core)

- `evals/tasks/<name>/` contains `task.md` (the goal given to `/team`), `fixture/` (small repo), `criteria.json` (checks: files exist, tests pass, commands exit 0, regex on artifacts).
- `team eval run` copies the fixture to a temp dir, starts a headless OpenCode session with the plugin **[VERIFY how: `opencode2` CLI/API]**, runs the task, evaluates criteria, stores `eval_runs`.
- Purpose: when a prompt change is proposed/approved, rerun evals and compare scores (`team eval report --by prompt_set_sha`). Humans use this to decide on approval.
- **Stack coverage:** ship at least three fixtures on different ecosystems (for example a TypeScript project, a Go project and a Python project, each with a trivial feature request) to demonstrate stack-agnosticism. `criteria.json` checks must use the fixture's own Stack Profile commands, not hardcoded ones.
- **Model comparison:** `team eval run --models <preset>` runs the same tasks under different model routings and stores `model_set_sha`, so `team eval report` can compare score, loops and cost across model sets.
- Mark the headless-run mechanism as pluggable; if headless runs are impractical, ship the harness with a stub runner and document the gap.

---

## 15. Verification register & fallbacks (Phase 0 deliverable)

Create `docs/api-notes.md` with a table: item → resolved answer → source (type file / doc URL / experiment). Items:

| # | Unknown | Default assumption | Fallback if false |
|---|---|---|---|
| V1 | Package/entrypoint names (`@opencode-ai/plugin/v2` vs `@opencode/plugin`) | `@opencode-ai/plugin@next`, `/v2` | Use what installed OpenCode resolves |
| V2 | Host runtime (Bun vs Node) | Bun | Pick adapter accordingly; both implemented |
| V3 | Agent draft fields: prompt, permission, model, tools | `prompt`, `permission:{edit,bash}`, `model` | Put the prompt in the agent via the closest field; if no permission field, rely on gate hook + prompts |
| V4 | Agent `mode` accepts `"primary"` | yes | Use whatever value marks a primary agent, or leave default and set the default agent via `agents.default(...)` **[DOC: op exists]** |
| V5 | Edit tool names / input keys in V2 | `edit`,`write`,`patch` / `filePath` | Read from installed tool definitions; make `gating.editTools` + a key-extractor configurable |
| V6 | Do tool hook events carry `sessionID`, `agent`, `toolCallID`? | maybe | Resolve run via single-open-run rule; skip scope gate; duration = NULL |
| V7 | `event.system` type in request hook | string[] | Support string too |
| V8 | Does the request hook expose current agent/model? | maybe | Inject role-agnostic lessons only |
| V9 | `ctx.event.subscribe` signature & event names | unknown | Skip event tracing (§9.4) |
| V10 | How tool failure should be signaled | return `ok:false` text | Throw if tools support error channel better |
| V11 | Hot-reload watching of `.team/` changes | not watched | Use `ctx.agent.reload()` on marker polling or require restart |
| V12 | How to run OpenCode headless for tests/evals | `opencode2` CLI/API | Skip integration tests; keep unit tests with fake ctx |
| V13 | Field and string format for an agent's model (`provider/model`?) | `model: "provider/model"` | Use whatever the installed agent draft accepts; if none, document that per-role models are unsupported and every role inherits |
| V14 | Agent draft fields for params (`temperature`, `topP`, `reasoningEffort`/variant, `maxSteps`, `maxOutputTokens`) and the catalog shapes (`ctx.catalog.model.list`, `provider.list`: availability, tool-call capability, cost, limits, reasoning support) | v1-like names; catalog exposes capabilities | Apply only the params the draft accepts; skip capability validation and trace `model.validation_skipped` if metadata is missing; disable `auto` |
| V15 | Whether `ctx.catalog.model.default` can be read synchronously inside setup | async read | Read lazily; report the host default only in `team models` |
| V16 | How the plugin learns the project directory for detection (no `directory` in the V2 ctx?) | `process.cwd()` is the project dir | Use the directory exposed by ctx (check for `project`-like fields) or the config file location |
| V17 | Whether `ctx.agent.reload()` re-applies model/prompt changes at runtime | yes **[DOC: op exists]** | Require an OpenCode restart after approving prompts or editing model config; document it |

If a verification contradicts the default **and** no fallback works, stop and report with details.

---

## 16. Testing requirements

- **Unit (bun test / vitest):** config validation; role table; footer parser; artifact gate logic (every row of §7.2, pass and fail); state machine (advance, rewind, loop cap, escalation); run resolution order (§7.6); lesson ranking/budget/duplicate detection; DB migrations (fresh + upgrade); trace never throws (inject failing DB); CLI commands with a temp DB.
- **Model routing tests:** every step of the resolution order (§6.2), including zero config → all roles inherit; tier mapping; per-role override; fallback chain on a missing model, an unconnected provider and a non-tool-capable model; param filtering for unsupported params; diversity warning; `run_models` snapshot contents; a bad config never throws from `setup`.
- **Stack detection tests:** one fixture file listing per marker-table row (§6.3 item 4), including monorepo/workspace cases, multi-language projects, repos whose Makefile/scripts override ecosystem defaults, and an empty directory (empty profile). Resolution-order tests for human file > options override > run profile > detected. Detection must not execute any command or touch the network (assert via spies).
- **Agnosticism lint test:** the prompt denylist scan in §6.3 item 8.
- **Fake ctx (`test/fakes/ctx.ts`):** records `agent.transform` drafts, tool registrations, hook registrations; lets tests invoke tool executors and hooks directly. Test that the default export has `id === "delivery-team"` and that `setup` registers: all roles (minus disabled), all `team_*` tools, before/after hooks, request hook, commands.
- **Concurrency test:** two processes (or workers) write trace rows + advance different runs on one WAL DB without `SQLITE_BUSY` failures.
- **Integration (if V12 resolved):** load the plugin in a headless OpenCode; assert `opencode2 api get /api/plugin` includes `delivery-team`; call `team_start`/`team_advance` through a scripted session; assert edit-blocking before `implement`.
- **Typecheck:** `tsc --noEmit` clean, strict. **Lint:** whatever the repo configures; no `any` except at documented `[VERIFY]` boundaries (wrap them in one `compat.ts` module).

---

## 17. Milestones & acceptance criteria

**M0 — Discovery.** Install deps; read types; run a hello-world plugin (the `greeting` tool) loaded from `.opencode/plugins/`; confirm in `/api/plugin`. Output: `docs/api-notes.md` with every V-item resolved. *Accept:* all V1–V17 have an answer or a chosen fallback.

**M1 — Skeleton + agents + options + model routing.** Project layout, `config.ts`, `roles.ts`, `models.ts`, prompts, `agent.transform` registration (prompts, permissions, model, params), `compat.ts` boundary module. *Accept:* plugin loads; all agents visible in OpenCode; with no options every agent inherits the host default model; with tier/role options the configured model and params are applied (as far as V13/V14 allow); fallback and diversity warnings work; unit tests for config/roles/models pass.

**M2 — State machine + tools + SQLite + Stack Profile.** DB adapter, migrations, `team_start/status/advance/rewind/loop/note`, `team_stack/team_stack_update`, table-driven stack detection, artifact footers (including `COMMAND`/`EXIT`/`SKIPPED` rules), run resolution, `run_models` snapshot. *Accept:* scripted test drives a run through every phase; each gate denial case verified; loop cap escalates at `maxLoops+1`; detection passes fixtures for every marker-table row; resolution order (§6.3 item 3) verified.

**M3 — Gating hooks.** `execute.before` edit gate + scope gate (as far as V5/V6 allow), unresolved policy, bash-CLI block. *Accept:* edit attempt during `spec` is blocked with the documented message; allowed during `implement`; paths under `<root>/` always allowed.

**M4 — Observability.** `execute.after` tracing, events (if V9), `team_status`, CLI `runs/report/trace`. *Accept:* after a scripted run, `team report` shows per-phase durations, tool counts, gate denials, loops; tracing failures never fail a tool call (test with broken DB).

**M5 — Learning loop.** `team_lesson_propose`, FTS ranking, request-hook injection with budget, CLI approve/reject/export, prompt proposals + approve flow + reload. *Accept:* proposed lessons are never injected; approved are, within `topN`/`budgetChars`; approving a prompt changes the agent prompt after reload/restart (documented which).

**M6 — Parallel worktrees (optional flag) & evals harness.** `team_worktree`, concurrency test, `evals/` runner. *Accept:* two worktrees created for one run; concurrent writes succeed; eval harness runs at least one fixture end to end or ships as a documented stub.

**M7 — Packaging & docs.** `package.json` (`exports`, `bin`, `dependencies` includes every runtime import), README with install/config/usage, `docs/architecture.md`, `.gitignore` guidance, publish dry-run (`npm pack`) installs into a clean project and loads. *Accept:* clean-project install test passes; README quick start works verbatim.

---

## 18. Quality, safety & operational requirements

- **Never break the host:** every hook body wrapped so non-intentional errors are swallowed and traced; only the gate's *intentional* denial throws.
- **Privacy:** by default do not persist tool inputs/outputs; only names, sizes, timings, outcomes. Redact anything matching common secret patterns if `captureInput`/`previewChars` are enabled.
- **Shell safety:** all `git`/process spawns use argument arrays; validate names/paths; never run commands from agent-supplied strings without validation.
- **Performance:** request hook < 10 ms typical (indexed FTS query, small N). No synchronous network calls in hooks.
- **Determinism:** inject lessons in stable order (rank, then id) to avoid prompt-cache churn between consecutive requests of the same run when possible.
- **Idempotent setup:** `setup` may run repeatedly (reloads). Opening the DB, running migrations, and registering agents/tools must be safe to repeat; close DB in the cleanup.
- **Logging:** use OpenCode's logging facility if V-verified, else write warnings to the `events` table; no `console.log` noise in the TUI.
- **Versioning:** semver; note supported OpenCode V2 version range in README and `peerDependencies` if appropriate; tighten at GA.

---

## 19. Out-of-scope ideas (record, don't build)

OpenTelemetry exporter; web dashboard; automatic prompt A/B rollouts; cross-project lesson sharing; approval via chat; cost budgets per run; TUI sidebar showing the phase; Effect-based entrypoint.

---

## 20. Definition of done

1. All milestones M0–M7 acceptance criteria met (M6 may ship its harness as documented stub only if headless runs are impossible).
2. `tsc --noEmit` and the full test suite pass.
3. A clean-project install loads the plugin, `/team <goal>` drives a toy task through every phase with gates enforced, `team report <run>` produces the report, and an approved lesson appears in a later run's requests.
4. `docs/api-notes.md` lists every resolved `[VERIFY]` and every deviation from this spec.
5. Stack-agnostic demo: `/team <goal>` completes end to end on fixtures in at least three different ecosystems using each fixture's own Stack Profile commands, and the prompt-neutrality lint passes.
6. Model routing demo: a config with different models per tier/role is applied to the registered agents, `team models` shows it, the `run_models` snapshot is stored, and `team report` breaks cost down by role and model (if events are available).
