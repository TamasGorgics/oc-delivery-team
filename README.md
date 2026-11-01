# OpenCode Delivery Team

[![CI](https://github.com/TamasGorgics/oc-delivery-team/actions/workflows/ci.yml/badge.svg)](https://github.com/TamasGorgics/oc-delivery-team/actions/workflows/ci.yml)

A software delivery team for OpenCode V2. One plugin registers nine role agents, phase-gated tools and hooks, a human CLI, a learning loop, optional Git worktrees, and a fixture-based eval harness.

The plugin is deliberately stack-agnostic. Project-specific build, test, lint, and run commands come from the Stack Profile, not from hardcoded language assumptions.

## Requirements

- OpenCode `2.2.0` (the verified host version)
- Bun `1.4.4` or newer for the plugin runtime and `team` CLI
- Git for optional worktree support

The plugin stores machine state in SQLite and human-readable artifacts under `.team/`.

## Install

The package is distributed from GitHub tags while it is pre-1.0. You do **not** need a local checkout, and you do not need to add the plugin to the project's `node_modules`.

### Project plugin

Add the package tag to the project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:TamasGorgics/oc-delivery-team#v0.1.3",
      "options": {
        "root": ".team",
        "maxLoops": 3
      }
    }
  ]
}
```

OpenCode installs the package into its plugin cache and resolves the tag. Every developer using the project gets the same plugin version without cloning this repository.

Pin the tag. To upgrade, change `#v0.1.3` to the newer release tag and restart OpenCode. Use the same tag everywhere below.

### Global plugin

If you want the plugin in every project, install it through OpenCode instead:

```sh
opencode plugin add 'github:TamasGorgics/oc-delivery-team#v0.1.3'
opencode plugin list
```

This writes the package entry to the global OpenCode config. Edit that entry to add plugin options if needed.

### Human CLI

The `team` CLI is a separate executable. Install it globally from the same GitHub tag:

```sh
npm install --global 'github:TamasGorgics/oc-delivery-team#v0.1.3'
team --help
```

Or run it one-off without a global install:

```sh
npx --yes --package 'github:TamasGorgics/oc-delivery-team#v0.1.3' team --help
```

Bun must be installed and available on `PATH` because the package entry and CLI are TypeScript. To upgrade the CLI, run the install command with the new tag.

## Quick start

1. Open the project in OpenCode.
2. Start a run from the lead agent:

   ```text
   /team Add a small health-check endpoint and cover it with the project's existing tests.
   ```

3. The lead moves through:

   `brainstorm -> spec -> plan -> implement -> test -> qa -> adversary -> docs -> retro -> done`

   The `spec` subagent owns both the `spec` and `plan` phases. The built-in read-only `plan` agent is not part of this team.

4. Approve `spec.md` when the lead asks. The spec gate requires both `STATUS: APPROVED` and a decision note recording human approval.
5. When the run finishes, inspect it with:

   ```sh
   team runs
   team report <run-id>
   ```

The first command writes a database at `.team/team.db`. Use `--root <dir>` to select a different data root or `--db <file>` to override the database path.

## Artifact paths

`team_start` returns the run's exact `artifact_dir`. The lead must pass that directory to every subagent. Artifact-writing roles write fully qualified paths such as:

```text
<artifact_dir>/brainstorm.md
<artifact_dir>/spec.md
```

A bare `brainstorm.md` in the project root is outside the run directory and is blocked by the gate. If a role cannot write its artifact, pass it the exact path and retry; do not use another role to persist it.

## Configuration

Plugin options are passed under the `options` object in `opencode.json`:

| Option | Default | Purpose |
|---|---|---|
| `root` | `.team` | Data root for the database, run artifacts, prompt approvals, proposals, and exports |
| `dbPath` | `<root>/team.db` | SQLite database path |
| `maxLoops` | `3` | Loop-review cap per phase before escalation |
| `lessons.topN` | `8` | Maximum approved lessons considered per request |
| `lessons.budgetChars` | `4000` | Hard cap on injected lesson text |
| `stack.detect` | `true` | Detect the Stack Profile from project markers |
| `stack.overrides` | unset | Human-supplied Stack Profile overrides |
| `roles.disabled` | `[]` | Role ids to omit |
| `gating.enabled` | `true` | Enable phase and scope gates |
| `gating.strict` | `false` | Block tool calls that cannot be tied to an open run |
| `gating.editTools` | `["edit", "write", "patch"]` | Tools subject to edit gates |
| `gating.pathKeys` | unset | Per-tool input path-key overrides |
| `trace.captureInput` | `false` | Persist redacted tool inputs |
| `trace.previewChars` | `0` | Persist this many redacted output characters |
| `worktrees.enabled` | `false` | Enable the `team_worktree` tool |
| `worktrees.baseDir` | `../.team-worktrees` | Base directory for Git worktrees |

### Models

Every role inherits the OpenCode host model unless routing is configured. Model references use `provider/model` and optional variants. Presets in `evals/models/` use the same routing shape.

```json
{
  "plugins": [
    {
      "package": "opencode-delivery-team",
      "options": {
        "models": {
          "default": { "model": "provider/model-placeholder" },
          "tiers": {
            "reasoning": { "model": "provider/reasoning-placeholder" },
            "coding": { "model": "provider/coding-placeholder" },
            "fast": { "model": "provider/fast-placeholder" }
          },
          "roles": {
            "developer": { "model": "provider/developer-placeholder" }
          },
          "roleTier": {
            "researcher": "fast"
          },
          "params": {
            "developer": { "temperature": 0.1, "maxSteps": 40 }
          }
        }
      }
    }
  ]
}
```

These are placeholders. Use model references available in your OpenCode installation. Run `team models` after setup to inspect the resolved routing and any fallback warnings.

## Worktrees

Worktrees are optional and require a Git repository:

```json
{
  "plugins": [
    {
      "package": "opencode-delivery-team",
      "options": {
        "worktrees": {
          "enabled": true,
          "baseDir": "../.team-worktrees"
        }
      }
    }
  ]
}
```

When enabled, the lead may dispatch independent developer tasks in parallel. Each developer calls `team_worktree` with the run id and a unique lowercase name, works only in the returned path, and commits its branch. The lead coordinates integration in the main checkout through a developer, reviews the result, and records a decision note.

All worktrees share the main repository's `.team/` database and run artifacts. Worktrees are never deleted automatically; `team runs` lists delivery-team worktrees for manual cleanup.

## Human approvals

Agents may propose lessons and complete prompt overrides, but they cannot approve them.

```sh
# Lessons
team lessons [--status proposed]
team lessons approve|reject|retire <id>
team lessons export
team lessons stale

# Prompt overrides
team prompts list
team prompts diff <role.timestamp>
team prompts approve <role.timestamp>
team prompts reject <role.timestamp>
```

Approving a prompt moves it to `.team/prompts/<role>.md`, supersedes the previous version, and returns `restart_required: true`. The CLI runs outside the plugin host, so restart OpenCode to apply the approved prompt. A prompt file is used only when its SHA matches an approved `prompt_versions` row; direct edits are ignored.

Lessons are injected only after human approval. Proposed lessons and proposed prompts are never active.

## Code Mode

OpenCode's `execute` tool runs a restricted JavaScript-like sandbox, not unrestricted TypeScript or Node. In Code Mode:

- Call plugin tools as `tools.team_*`.
- Do not use `import()`, `require()`, classes, BigInt, timers, filesystem APIs, or `fetch`.
- Use the built-in `read`, `write`, and `shell` tools for file and command access.

An `ImportExpression is not supported` error means the generated Code Mode script tried to import a module. It is not a plugin installation failure.

## Evaluation harness

The eval harness exercises the plugin against fixture projects:

```sh
team eval run
team eval run ts-slug --models host-default
team eval report --by prompt_set_sha
```

Tasks live in `evals/tasks/` and model presets in `evals/models/`. The runner copies a fixture into a temporary project, uses the fixture's own Stack Profile commands, and stores one `eval_runs` row per task. Tests inject a fake runner; a live `team eval run` uses the OpenCode headless CLI and needs a configured model/provider.

## Version control

Commit approved behavior and exported lessons, but not the SQLite runtime state:

```gitignore
.team/team.db*
```

Keep `.team/prompts/` and `.team/lessons-export/` tracked if you want approved project behavior in version control. Run artifacts under `.team/runs/` may be committed or ignored according to your team's policy.

## Local plugin development

This repository can be loaded directly during development through `.opencode/plugins/delivery-team/index.ts`. The installed package uses the same `src/index.ts` entry through its `exports` field.

### Developing the plugin with itself

Yes, you can use the plugin to develop the plugin. OpenCode in this checkout already loads the local source through `.opencode/plugins/delivery-team/index.ts`; do not configure the published `github:...#v0.1.3` package for self-development, or you will run the released code instead of your working tree.

1. Start with a clean branch and run `/team` from this repository.
2. Let the lead drive the normal phase gates. Source edits are blocked before `implement`; the developer and tester edit and run the project's Stack Profile commands.
3. Use the source CLI while developing, not the globally installed release:

   ```sh
   bun run team runs
   bun run team report <run-id>
   bun run team lessons --status proposed
   ```

4. Restart OpenCode after changing plugin source files or approving a prompt. The running plugin is loaded in memory and does not hot-reload its own TypeScript changes.
5. Keep the working tree clean between runs and run `bun run typecheck && bun test` before merging changes.

Self-development uses the same `.team/` data root as other runs in this checkout. Run artifacts and the SQLite database are local state; approved prompts and lesson exports are the files intended for version control.

## Limitations

- No dashboard, OpenTelemetry exporter, or automatic prompt/lesson approval.
- Worktrees are optional and intentionally manual to clean up.
- Prompt approvals require an OpenCode restart.
- The plugin is developed and verified against OpenCode `2.2.0`; newer host releases require a compatibility check.
- Live evals require an available model/provider; the unit suite uses a deterministic fake runner.

## Development

```sh
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck
bun test
npm pack --dry-run --json --ignore-scripts
```

See [docs/architecture.md](docs/architecture.md) for the design, [docs/SPEC.md](docs/SPEC.md) for the source specification, [docs/ROADMAP.md](docs/ROADMAP.md) for the delivery roadmap, and [docs/release.md](docs/release.md) for the release checklist.
