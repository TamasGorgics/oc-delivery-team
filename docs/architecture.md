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

With `reviews.parallel` enabled, `qa` becomes a two-artifact review wave and the separate `adversary` phase is skipped:

`brainstorm -> spec -> plan -> implement -> test -> qa (qa.md + adversary.md barrier) -> docs -> retro -> done`

The default remains fully sequential, and the wave can be turned off without changing existing runs.

Phase ownership is fixed:

| Phase | Owner |
|---|---|
| brainstorm | researcher |
| spec | spec |
| plan | spec |
| implement | developer |
| test | tester |
| qa | qa (+ adversary in parallel review mode) |
| adversary | adversary (sequential mode only) |
| docs | docs |
| retro | retro |

The spec subagent owns both `spec.md` and `plan.md`. The `plan` phase is verification-only when `plan.md` exists; if it is missing, the lead re-dispatches `spec`. OpenCode's built-in `plan` agent is not part of this team, and the gate blocks it during an active run.

`team_advance` evaluates the current phase gate before changing state. Gates require the expected artifact and machine-readable footer; the spec gate additionally requires a human approval decision note. `team_rewind` moves work backward, and loop counters escalate at the configured cap. State changes and phase transitions are persisted in SQLite.

`team_status` reports the current phase, gate result, counters, loops, notes, and recent events. Entering `retro` writes a Markdown report to the run directory, and advancing out of `retro` closes the run.

## Review wave

`src/state/reviews.ts` is a pure, read-only helper for the optional parallel review wave. It owns the member list and artifact names, `qa -> docs` advance target, barrier evaluation, the additive `review_wave` status payload, and the shared gate/status serializers. It does not write files, loops, or events.

- **Barrier.** `evaluateReviewBarrier` calls `validatePhaseGate` for `qa` and then `adversary` in fixed order with no short-circuit. The top-level result uses the first failing member for `code`/`artifact`/`artifact_path`/`footer` and aggregates every failing member in the message; `members` always contains both outcomes. A missing member artifact does not stop the other member from being evaluated.
- **Advance.** `team_advance` uses the barrier only when the effective option is true and the open run is in `qa`; it then targets `docs`. Every other phase keeps `nextPhase()` and the existing single-artifact gate. On denial it keeps the `gate_denied` failure shape, emits `gate.denied`, and adds `review.wave.denied`; on success it writes one `qa -> docs` transition and emits `phase.advanced` plus `review.wave.completed`. Entering `qa` from `test` emits `review.wave.started` with `cause: "advance"`.
- **Status.** `team_start` always advertises the additive `review_wave` object (`enabled`, `active`, `ready`, `phase`, `members`, `artifacts`, `generation`; `started_at` while active). `team_status` adds per-member gates and loops, keeps `loops` limited to phase-level rows, adds `role_loops` only when role rows exist, and makes the barrier the top-level `gate` while active. `counters.loops` sums every row.
- **Rewind.** While enabled, `team_rewind(to="adversary")` returns `review_wave_rewind_blocked` before the earlier-phase check. A rewind to `qa` increments the wave-level `(qa, "")` counter, preserves member counters, and emits `loop.incremented`, `phase.rewound`, then `review.wave.started` with `cause: "rewind"`. The wave cap is the normal `maxLoops` check on the wave-level key; exceeding it escalates without a transition.
- **Fallback.** The barrier checks file contents, not scheduling. If the host serializes child sessions or a reviewer fails to start, the lead runs the missing reviewer sequentially in the same `qa` phase; either completion order passes once both artifacts satisfy their footers.
- **Ownership.** Artifact ownership remains a prompt/trust rule in M8. The gate verifies `qa.md` and `adversary.md`, not which agent wrote them; a hard ownership gate is a deferred follow-up.

## Role-scoped loops and migration 3

Loop rows are keyed by `(run_id, phase, role)`; the empty role is the phase/wave scope. `RunRepository` defaults every legacy call site to `role = ""`, and `incrementLoop` performs the UPSERT and read-back in one short transaction. In an active wave, reviewer calls infer their role, non-reviewers must supply it, and `maxLoops` applies per key. `countPhaseEntries(run_id, "qa")` counts advance/rewind transitions into `qa` and backs the `generation` field.

Migration 3 rebuilds `loops` in one transaction: it creates a scratch table with the new role column and primary key, aggregate-copies legacy rows into `role = ''` with `SUM(count)`, drops and renames tables, then verifies the required columns, `role NOT NULL`, and exact primary-key order. The rebuild repairs a drifted table that has no matching primary key or duplicate `(run_id, phase)` rows; verification or copy failure rolls back to the old table and counts. `migrate()` re-reads `schema_migrations` for a version inside that migration's transaction, so concurrent first opens do not double-apply, and `toVersion` comes from the post-run maximum. Orphan legacy loop rows that reference a missing run fail the foreign-key check and roll back safely; they must be cleaned up before retrying.

## Agents and prompts

Each role has one responsibility, a default prompt, a model tier, a write scope, and a shell policy. Developers commit their verified changes; the read-only lead never commits, runs git, or edits files. Agents are registered through `agent.transform`; prompts are resolved from:

1. an approved `.team/prompts/<role>.md` override whose SHA matches an approved `prompt_versions` row, or
2. the built-in prompt in `src/prompts/`.

The human CLI is the only approval path for prompts and lessons. Pending proposals are never loaded as active prompts.

## Data boundaries

- SQLite stores runs, transitions, sessions, tool calls, messages, loops, notes, lessons with FTS, prompt versions, and eval runs.
- Markdown stores phase artifacts, reports, approved prompts, pending proposals, and lesson exports.
- Runtime `.team/team.db*` files are ignored by Git. Approved prompts and lesson exports are intended to be committed.

Worktrees and concurrent reviewer processes share the main repository's `.team/` directory. This is intentional: one database and one run history are shared by all parallel workers. The adapter opens SQLite in WAL mode with `busy_timeout=5000`, short transactions, a transactional loop UPSERT, and retries for transient lock errors during WAL setup. The two-process review concurrency test writes distinct role artifacts, role-scoped loops, notes, and status for one `qa` run without `SQLITE_BUSY`; host-level dispatch concurrency is separate and falls back to sequential reviewers.

## Safety and observability

- Review identity is preserved end to end: child tool calls carry `agent: "qa"`/`"adversary"`, notes keep the caller agent, loop events add `role` only for non-empty roles, and the `review.wave.*` events record the wave lifecycle. `team report` renders role-qualified loop rows and a `## Review wave` section only when wave events exist; JSONL trace output needs no format change.
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
| `src/state/reviews.ts` | Review-wave members, advance target, barrier, status payload, and serializers |
| `src/tools/`, `src/hooks/`, `src/commands.ts` | Orchestration surface and host hooks |
| `src/cli/` | Human-only CLI |
| `src/evals/` | Task loading, criteria, runner, snapshots, and reports |
| `evals/tasks/`, `evals/models/` | Shipped fixtures and model presets |
| `test/` | Unit tests, fakes, and test fixtures |
