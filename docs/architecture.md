# Architecture

The delivery team is an OpenCode V2 plugin plus a human-only CLI. The plugin owns orchestration, phase gates, persistence, learning, and optional worktrees; the CLI owns approval and inspection. The design follows SPEC §3 and §4.

## Runtime shape

```text
OpenCode host
  ├─ agents            nine role agents, prompts, permissions, models
  ├─ commands          /team, /team-status, /team-retro
  ├─ tools             team_* orchestration and inspection
  ├─ execute hooks     phase/scope gate and trace capture
  ├─ context hook      approved lesson injection and request options
  └─ event stream      session, tool, usage, and message tracing
             │
             ├── SQLite .team/team.db
             └── Markdown .team/runs/<run>/ and approved prompt files
```

Plugin setup opens and migrates the database, resolves model routes, registers agents, commands, tools, hooks, and the event iterator, then reloads the agent transform so approved prompt overrides are applied. Every registration has a disposer. Setup failures are captured in warnings; the host remains loaded whenever possible.

## Phase pipeline

A run moves through:

`brainstorm -> spec -> plan -> implement -> test -> qa -> adversary -> docs -> retro -> done`

`team_advance` evaluates the current phase gate before changing state. Gates require the expected artifact and machine-readable footer; the spec gate additionally requires a human approval decision note. `team_rewind` moves work backward, and loop counters escalate at the configured cap. State changes and phase transitions are persisted in SQLite.

`team_status` reports the current phase, gate result, counters, loops, notes, and recent events. Entering `retro` writes a Markdown report to the run directory, and advancing out of `retro` closes the run.

## Agents and prompts

Each role has one responsibility, a default prompt, a model tier, a write scope, and a shell policy. Agents are registered through `agent.transform`; prompts are resolved from:

1. an approved `.team/prompts/<role>.md` override whose SHA matches an approved `prompt_versions` row, or
2. the built-in prompt in `src/prompts/`.

The human CLI is the only approval path for prompts and lessons. Pending proposals are never loaded as active prompts.

## Data boundaries

- SQLite stores runs, transitions, sessions, tool calls, messages, loops, notes, lessons with FTS, prompt versions, and eval runs.
- Markdown stores phase artifacts, reports, approved prompts, pending proposals, and lesson exports.
- Runtime `.team/team.db*` files are ignored by Git. Approved prompts and lesson exports are intended to be committed.

Worktrees share the main repository's `.team/` directory. This is intentional: one database and one run history are shared by all parallel workers.

## Safety and observability

- Only an intentional gate denial throws. Trace, event, and injection paths swallow and record their own failures.
- Edit and scope gates run in `execute.before`; the CLI approval commands are blocked from agent shell sessions.
- Trace capture is opt-in and redacts secret-like values before persistence and export.
- Approved lessons are ranked with FTS/BM25, scoped by role and stack, capped by `topN` and `budgetChars`, and injected through the context hook. The hook performs no network I/O and never fails the request.
- Every model request can inherit the host default; optional routing maps roles and tiers to configured models with fallback diagnostics.

## CLI and evaluation

The human CLI (`src/cli/team.ts`) manages runs, reports, traces, lessons, prompts, worktrees, and evals. It uses the same SQLite repositories as the plugin but runs outside the host process.

The eval harness copies a fixture into a temporary project, seeds the effective approved prompt set, invokes a pluggable headless runner, evaluates versioned criteria, and stores reproducible prompt/model hashes in `eval_runs`. Fixture criteria use the fixture's Stack Profile rather than hardcoded language commands.

## Source layout

| Path | Responsibility |
|---|---|
| `src/index.ts` | Plugin registration and setup lifecycle |
| `src/config.ts` | Option parsing and defaults |
| `src/roles.ts`, `src/prompts/` | Role definitions and built-in prompts |
| `src/models.ts` | Model routing, fallbacks, and request options |
| `src/stack/` | Stack detection, profile resolution, and commands |
| `src/state/` | SQLite adapter, repositories, gates, tracing, reports |
| `src/tools/`, `src/hooks/`, `src/commands.ts` | Orchestration surface and host hooks |
| `src/cli/` | Human-only CLI |
| `src/evals/` | Task loading, criteria, runner, snapshots, and reports |
| `evals/tasks/`, `evals/models/` | Shipped fixtures and model presets |
| `test/` | Unit tests, fakes, and test fixtures |
