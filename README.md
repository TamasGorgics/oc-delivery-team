# OpenCode Delivery Team

A software delivery team for OpenCode V2. One plugin registers nine role agents, phase-gated tools and hooks, a human CLI, a learning loop, optional Git worktrees, and a fixture-based eval harness.

The plugin is deliberately stack-agnostic. Project-specific build, test, lint, and run commands come from the Stack Profile, not from hardcoded language assumptions.

## Requirements

- OpenCode `2.2.0` (the verified host version)
- Bun `1.4.4` or newer for the plugin runtime and `team` CLI
- Git for optional worktree support

The plugin stores machine state in SQLite and human-readable artifacts under `.team/`.

## Install

Install the package in the project that OpenCode will open:

```sh
bun add opencode-delivery-team
```

For a local tarball:

```sh
npm install /absolute/path/to/opencode-delivery-team-0.1.0.tgz
```

Add the installed package to `opencode.json`. The local package path works for both tarball and registry installs; it is also what `opencode` uses for a package loaded from the project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./node_modules/opencode-delivery-team",
      "options": {
        "root": ".team",
        "maxLoops": 3
      }
    }
  ]
}
```

If you manage plugins globally, `opencode plugin add opencode-delivery-team` installs and records a registry package instead. Restart OpenCode after changing plugin options or approving a prompt override.

## Quick start

1. Open the project in OpenCode.
2. Start a run from the lead agent:

   ```text
   /team Add a small health-check endpoint and cover it with the project's existing tests.
   ```

3. The lead moves through:

   `brainstorm -> spec -> plan -> implement -> test -> qa -> adversary -> docs -> retro -> done`

4. Approve `spec.md` when the lead asks. The spec gate requires both `STATUS: APPROVED` and a decision note recording human approval.
5. When the run finishes, inspect it with:

   ```sh
   bunx -p opencode-delivery-team team runs
   bunx -p opencode-delivery-team team report <run-id>
   ```

The first command writes a database at `.team/team.db`. Use `--root <dir>` to select a different data root or `--db <file>` to override the database path.

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
bunx -p opencode-delivery-team team lessons [--status proposed]
bunx -p opencode-delivery-team team lessons approve|reject|retire <id>
bunx -p opencode-delivery-team team lessons export
bunx -p opencode-delivery-team team lessons stale

# Prompt overrides
bunx -p opencode-delivery-team team prompts list
bunx -p opencode-delivery-team team prompts diff <role.timestamp>
bunx -p opencode-delivery-team team prompts approve <role.timestamp>
bunx -p opencode-delivery-team team prompts reject <role.timestamp>
```

Approving a prompt moves it to `.team/prompts/<role>.md`, supersedes the previous version, and returns `restart_required: true`. The CLI runs outside the plugin host, so restart OpenCode to apply the approved prompt. A prompt file is used only when its SHA matches an approved `prompt_versions` row; direct edits are ignored.

Lessons are injected only after human approval. Proposed lessons and proposed prompts are never active.

## Evaluation harness

The eval harness exercises the plugin against fixture projects:

```sh
bunx -p opencode-delivery-team team eval run
bunx -p opencode-delivery-team team eval run ts-slug --models host-default
bunx -p opencode-delivery-team team eval report --by prompt_set_sha
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

See [docs/architecture.md](docs/architecture.md) for the design and [docs/release.md](docs/release.md) for the release checklist.
