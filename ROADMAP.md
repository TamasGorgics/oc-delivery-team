# ROADMAP — `opencode-delivery-team`

Implementation roadmap for [SPEC.md](./SPEC.md) (draft v1.1). The spec is the source of truth; this roadmap sequences it into gated milestones, concrete deliverables, and executable acceptance checks.

> **Working rule:** finish and verify a milestone before starting the next. Every milestone must leave the plugin loadable, the repo typechecking, and the test suite green.

## Status at a glance

| Milestone | Theme | Size | Depends on | Status |
|---|---|---|---|---|
| **M0** | API discovery and hello-world proof | M | — | ☑ Done |
| **M1** | Skeleton, agents, options, model routing | L | M0 | ☑ Done |
| **M2** | State machine, tools, SQLite, Stack Profile | L | M1 | ☑ Done |
| **M3** | Gating hooks | M | M2 | ☑ Done |
| **M4** | Observability: tracing, events, CLI reports | M | M2, M3 | ☑ Done |
| **M5** | Learning loop: lessons, prompt proposals, approvals | L | M2, M4 | ☐ Not started |
| **M6** | Parallel worktrees and eval harness (optional flag) | L | M2, M4 | ☐ Not started |
| **M7** | Packaging, documentation, clean-install release | M | all | ☐ Not started |

Legend: ☐ not started · ◐ in progress · ☑ done · ⊘ blocked.

```
M0 ──► M1 ──► M2 ──┬──► M3 ──► M4 ──► M5 ──┐
                   │                       ├──► M6 ──► M7
                   └───────────────────────┘
```

Recommended execution is sequential. After M2, M3 and M4 can proceed in parallel if more than one implementer is available; M6 worktrees can start after M2, while evals need M4.

## How to use this roadmap

1. Start with M0. Do not write feature code until the M0 exit gate passes.
2. Treat each milestone as a release gate: all acceptance checkboxes checked, `docs/api-notes.md` updated, typecheck and tests green.
3. Use the checkboxes as the progress ledger and update the status table when a milestone starts or closes.
4. If implementation contradicts the spec, record the deviation in `docs/api-notes.md`; do not silently invent API surface.
5. Every milestone ends with a plugin smoke test in a real OpenCode instance, not only unit tests.

## Delivery principles

- **Walking skeleton first.** M0 proves loading and one tool; M2 proves the full phase pipeline with scripted tool calls. Layer enforcement, observability, and learning onto a working pipeline.
- **Handoff by file, not chat.** Tools return paths; artifacts stay in `.team/runs/<run>/`.
- **Machine state in SQLite; human artifacts in Markdown.**
- **Enforcement in tools and hooks.** Prompts guide; the gate blocks.
- **Humans approve future behavior.** No agent-callable approval path for lessons or prompts.
- **Stack-agnostic by construction.** No language/framework assumptions in plugin logic or default prompts; always use the Stack Profile.
- **Models are configuration.** No model IDs in code or default prompts; zero configuration inherits the host default.
- **Hooks never break the host.** Only an intentional gate denial may throw; everything else is caught and traced.
- **One `compat.ts` boundary.** All `[VERIFY]` API shapes and `any` casts live there; the rest of the code uses stable internal types.
- **Small, tested modules.** Pure functions where possible; strict TypeScript; no native npm modules.

---

## M0 — API discovery and hello-world proof

**Goal:** eliminate API uncertainty before feature code. Produce a verified map of the installed OpenCode V2 plugin API.

**Deliverables**

- `package.json`, `tsconfig.json`, `.gitignore`
- `docs/api-notes.md` with every V1–V17 item resolved
- A throwaway working plugin loaded by OpenCode with one callable `greeting` tool
- Pinned versions for OpenCode and the plugin SDK/types package

### M0.1 — Scaffold and prove plugin loading

- [x] Create `package.json` (`type: "module"`, scripts for typecheck/test), strict `tsconfig.json`, and `.gitignore` (`.team/team.db*`, build output, local caches).
- [x] Determine the installed OpenCode release and the plugin package it resolves. Install the SDK/types package at the exact version; pin it in `package.json`.
- [x] Choose the host runtime and test runner: Bun + `bun test` by default; Node ≥ 22 + `vitest` if the host is Node. Record the decision in `docs/api-notes.md`.
- [x] Create a throwaway `.opencode/plugins/hello/index.ts` exporting `Plugin.define({ id: "hello", setup })` with a `greeting` tool that returns a text result.
- [x] Load it in OpenCode and verify the plugin is active (via `/api/plugin` or the equivalent endpoint for the installed release).
- [x] Invoke the `greeting` tool from a session and confirm the result reaches the model.
- [x] Verify that the setup cleanup function runs on reload/unload, and that repeated setup is safe.
- [x] Confirm how this repo itself will be loaded during development (local path in `opencode.json`, `.opencode/plugins/` symlink, or absolute path) and document it.
- [x] Remove the throwaway hello plugin and its probe test at the M0 exit gate; it is not a deliverable.

### M0.2 — Resolve every `[VERIFY]` item

Read the installed `.d.ts` files first; use docs and throwaway experiments only to fill gaps. Record the source of each answer.

| Group | Items | What to prove |
|---|---|---|
| Packaging and runtime | V1, V2, V12, V16 | Exact package/entrypoint; Bun vs Node; headless OpenCode mechanism; how the plugin obtains the project directory |
| Agents and models | V3, V4, V13, V14, V15, V17 | Agent draft fields for prompt, permissions, model, params, mode; catalog shapes for model listing/default/capabilities; reload behavior |
| Tools and tool hooks | V5, V6, V10 | Edit/write/patch tool names and input keys; whether hook events carry `sessionID`, `agent`, `toolCallID`; how tool failures are signaled |
| Request hooks and events | V7, V8, V9, V11 | Request/context hook name; `system` type; current agent/model exposure; event subscription signature, session/message events, parent IDs, token/cost fields; file watching/reload |
| SQLite | V2 | Whether `bun:sqlite` or `node:sqlite` is available in the actual plugin host; WAL support |

Concrete probes to run:

- [x] Register a test subagent through `agent.transform`; inspect it in OpenCode; try system, permission, model, and param fields.
- [x] Register a tool hook, deliberately throw in `execute.before`, and confirm the tool call is blocked; inspect the full event object.
- [x] Register a session context hook; append a system instruction and confirm it reaches the model; inspect `event.system`, agent, model, options, and tools.
- [x] Subscribe to the event stream; observe session creation, child-session parent IDs, completion/error, and token/cost data.
- [x] Open temporary SQLite databases with both available drivers; verify `journal_mode=WAL`, `busy_timeout`, and foreign keys.
- [x] Verify headless `opencode --standalone run` and the long-running `opencode serve` API path.

### M0.3 — Write `docs/api-notes.md`

- [x] Record the exact OpenCode version, SDK package version, runtime, and test runner.
- [x] Add a row for each V1–V17: question, resolved answer, source (type file / doc URL / experiment), fallback, and deviation from SPEC.
- [x] Record decisions that will shape later milestones: package name, hook names, tool result shape, event-tracing feasibility, headless feasibility, and logging.
- [x] Keep the document short enough to be read before each milestone.

### M0.4 — Discovery exit gate

- [x] All V1–V17 have an answer or a documented fallback.
- [x] The hello-world plugin loaded and its tool was callable before probe cleanup.
- [x] A test agent was visible in OpenCode.
- [x] A tool hook blocked an operation intentionally without crashing the host.
- [x] A context hook injected a system instruction.
- [x] SQLite opened a WAL database in the plugin runtime.
- [x] The package/entrypoint and runtime are pinned.
- [x] No unresolved item requires inventing API surface; contradictions have documented fallbacks.
- [x] Remove the temporary discovery and hello plugins and the hello-only test; retain only the installed-API contract test, with no product implementation or loaded probe code.

**Suggested commits:** `chore: scaffold plugin project` → `test: prove v2 plugin loading` → `docs: record v2 api findings`.

---

## M1 — Skeleton, agents, options, and model routing

**Goal:** a loadable plugin that registers the full team and resolves each role to the right model — with zero configuration inheriting the host default.

**Deliverables**

- `src/index.ts`, `src/config.ts`, `src/roles.ts`, `src/models.ts`, `src/compat.ts`, `src/commands.ts`
- `src/prompts/<role>.ts` for all nine roles
- `test/fakes/ctx.ts`
- Unit tests for config, roles, prompts, model routing, commands, and registration

### M1.1 — Plugin skeleton, config, roles, prompts

- [x] Implement `Plugin.define({ id: "delivery-team", setup })` with idempotent setup and registration cleanup.
- [x] Implement `config.ts`: manual validation with SPEC §5 defaults; unknown and invalid keys warn without failing; nested `models`, `stack`, `gating`, `trace`, `worktrees`, and `roles.disabled` are normalized.
- [x] Implement `roles.ts`: all nine roles with mode, read-only/write scope, tool needs, prompt id, default tier, and default `maxSteps` (SPEC §6, §6.2).
- [x] Write default prompts for all roles with the required responsibility, artifact/footer, “pass paths, not content”, scope, `team_note`, and retry instructions. The lead prompt encodes the pipeline, loop-cap escalation, artifact gates, and human spec-approval question.
- [x] Keep prompts free of model IDs, stack assumptions, and unlabeled toolchain examples.
- [x] Keep prompts stack-neutral. Put any toolchain examples inside clearly labeled example blocks.
- [x] Write prompts against the target tool set; defer executable pipeline tools to M2 and lesson/prompt-proposal instructions to M5.
- [x] Implement `compat.ts` for the loose SDK options boundary, model/catalog mapping, and agent draft/upsert/model fields. Tool-result adapters remain with M2 tools.
- [x] Register agents through `agent.transform`; respect `roles.disabled`; register `team-lead` as primary without changing the host default agent.
- [x] Implement `src/commands.ts` and register `/team`, `/team-status`, `/team-retro` through `command.transform`; commands are inert until the matching tools land.
- [x] Resolve prompts in order `<root>/prompts/<role>.md` (human-approved) then built-in default; reread inside the transform and replay with `ctx.agent.reload()`.
- [x] Build `test/fakes/ctx.ts` to record and replay agent transforms, commands, catalog reads, and the M1 context hook; add tool executors/hooks as their M2/M3 APIs land.
- [x] Test the plugin id, all enabled roles, the three commands, disabled roles, cleanup, and model-request hooks.

### M1.2 — Model routing

- [x] Represent tiers (`reasoning`, `coding`, `fast`), role defaults, and per-role `roleTier` moves.
- [x] Implement resolution order exactly: `roles.<role>` → `tiers.<tier>` → `default` → inherit.
- [x] Accept both spec forms: `"provider/model"` and `{ model, params?, fallback?: string[] }`.
- [x] Validate resolved models best-effort through model/provider catalogs: existence, provider availability, and tool-calling support. Never fail setup on a bad model.
- [x] Walk fallbacks in order and retain `model.fallback` diagnostics with reasons in the in-memory snapshot; M2/M4 will persist them through the trace boundary.
- [x] Filter params to supported keys and installed hook/agent fields; warn and ignore unknown or unsupported params.
- [x] Warn when `adversary` and `developer` resolve to the same effective model; never silently swap. M2/M4 will surface the snapshot in status/report.
- [x] Default `auto` to false; validate it and report `model.auto_unsupported` when enabled rather than inventing automatic routing.
- [x] Apply model, variant, and step settings through the agent transform/compat boundary; apply generation options through the V14 context hook.
- [x] Expose an in-memory resolution snapshot for M2 to persist to `run_models`.
- [x] Test zero-config inheritance, tiers, role overrides, `roleTier`, missing/unavailable/non-tool models, fallback, unsupported params, diversity, and non-fatal bad configuration.
- [x] Add the prompt-neutrality lint test for `src/prompts/**` (SPEC §6.3 item 8).

### M1.3 — Milestone gate

- [x] Plugin loads in OpenCode; all nine agents are visible, and disabled-role behavior is covered by tests.
- [x] `/team`, `/team-status`, and `/team-retro` are registered and visible.
- [x] With no options, every agent inherits the host default model.
- [x] Tier/role options, parameters, and fallback paths are covered and applied as allowed by V13/V14.
- [x] Diversity warnings are produced in the in-memory resolution snapshot; persistent status/report exposure is an M2/M4 task.
- [x] Unit tests for config, roles, prompts, models, commands, compatibility, and registration pass.
- [x] `tsc --noEmit` is clean under strict mode.
- [x] `docs/api-notes.md` records M1 behavior and remaining trace-persistence deviations.

**Suggested commits:** `feat: scaffold plugin config and roles` → `feat: add role prompts and agent registration` → `feat: add model tier routing` → `test: cover model resolution and fallbacks`.

---

## M2 — State machine, tools, SQLite, and Stack Profile

**Goal:** a scripted run can move through every phase with durable state, validated artifacts, loop caps, and stack-aware commands.

**Deliverables**

- DB adapter, migrations, repositories, safe trace API
- Artifact and footer validation
- Stack Profile schema, marker table, pure detector, resolution order, stack tools
- Core tools: `team_start`, `team_status`, `team_advance`, `team_rewind`, `team_loop`, `team_note`
- `run_models` snapshot and phase transitions
- CLI scaffold: `team db migrate`, `team stack`, `team models`

### M2.1 — Database foundation

- [x] Implement `state/db.ts` with the interface from SPEC §10.1 and runtime adapters: `bun:sqlite` when Bun, otherwise `node:sqlite`. No native npm modules.
- [x] Apply `PRAGMA journal_mode=WAL`, `busy_timeout=5000`, and `foreign_keys=ON` on open.
- [x] Resolve the database path against the **main repo directory**, not a worktree; use `git rev-parse --git-common-dir` when available, with a safe fallback.
- [x] Implement `state/schema.ts` migration 1 exactly as SPEC §10.2: runs, run_models, phase_transitions, loops, sessions, tool_calls, events, messages, notes, lessons, lessons_fts with sync triggers, prompt_versions, eval_runs.
- [x] Add `schema_migrations` with ordered, idempotent steps; test fresh install and upgrade.
- [x] Implement repositories in `state/runs.ts` and stubs for `lessons.ts`; all writes use parameterized statements and short transactions.
- [x] Implement `state/trace.ts`: `trace.event` and `trace.toolCall` swallow and log errors, never throw; a broken DB must not fail a tool call.
- [x] Ensure setup/migration is safe to run repeatedly across plugin reloads.

### M2.2 — Artifacts, footers, and phase gates

- [x] Implement `state/artifacts.ts`: run artifact paths, footer parser (case-sensitive keys, last occurrence wins), and footer validation.
- [x] Encode the required-artifact table from SPEC §7.2 with phase-specific footer conditions.
- [x] Enforce test rules: `RESULT: PASS` requires `EXIT: 0`; `RESULT: SKIPPED` is allowed only when the profile has no test command and a `team_note(kind="decision")` explains why.
- [x] Implement spec approval tracking: `STATUS: APPROVED` plus a `human_approval` decision note; do not pretend the plugin can verify human approval.
- [x] Define clear denial messages that name the missing file and expected footer line.

### M2.3 — Stack Profile

- [x] Implement `src/stack/profile.ts`: schema, validation, JSON merge patch, resolution order, and default profile.
- [x] Implement `src/stack/markers.ts` as a data table covering every ecosystem in SPEC §6.3 item 4, plus task runners, Docker, Nix, and monorepo/workspace markers.
- [x] Implement `src/stack/detect.ts` as a pure function over a file listing and small file reads. No command execution, no network, no writes.
- [x] Detect monorepos and multi-language projects as multiple components; prefer repo-declared commands (scripts, Makefile/just/Task targets, CI config) over ecosystem defaults.
- [x] Implement resolution order: human `<root>/stack.json` → `options.stack.overrides` → run-stored profile → detected → empty.
- [x] Implement default test/docs globs for scope gating when the profile has none; trace `gate.scope_default` when used.
- [x] Implement `team_stack` (return/resolve/persist, honoring `refresh`) and `team_stack_update` (validated merge patch, source `researcher`, refuse to override human-owned fields).
- [x] Persist the profile to `runs.stack_json` and `<run>/stack.json`.
- [x] Keep the invariant that the plugin never executes profile commands itself; agents run them with their own tools.
- [x] Use `node:path` for all path handling; preserve an optional `shell` hint; keep plugin logic OS-neutral (Windows is not a v1 target but must not be precluded).

### M2.4 — Core tools and state machine

- [x] Define a shared tool result contract: JSON-schema input with `additionalProperties: false`; expected failures return an `ok:false` text result instead of throwing.
- [x] Implement run resolution exactly as SPEC §7.6: explicit `run` → calling session → parent session → single open run → ambiguous/none.
- [x] Implement `team_start`: run id `<base36-ts>-<slug>`, run directory, session binding, initial phase, `run.start` trace, and `run_models` snapshot (role, model or NULL, params, source); return the run id and artifact directory.
- [x] Implement `team_status`: phase, required artifact/footer status, loop counters, open lesson count, recent events.
- [x] Persist caller `agent`, `sessionID`, and `toolCallID` on every tool-originated trace row where available.
- [x] Upsert `sessions` from tool executor context (`id`, `agent`, `run_id`) so subagent run resolution works before event tracing lands in M4.
- [x] Implement `team_advance`: validate the phase gate; on failure return the reason and trace `gate.denied`; on success transition exactly one phase, record the transition and duration, and treat `done` as terminal (refuse advances after it).
- [x] Implement `team_rewind`: earlier-phase validation, reason, loop increment on re-entry, `ESCALATE_TO_HUMAN` at `maxLoops`, `loop.exceeded` event.
- [x] Implement `team_loop`: increment/check the current phase counter and return remaining loops or escalation.
- [x] Implement `team_note`: append `decision` / `finding` / `risk` / `question` with caller agent and session.
- [x] Add a minimal `report.md` generator for entering `retro` (phase durations, loops, gate denials, notes); enrich it in M4.
- [x] Ensure `done` is terminal and closes the run; enforce run statuses `open | blocked | closed | aborted`.
- [x] Implement `src/cli/team.ts` with `team db migrate`, `team stack [<run>]` (including provenance), and `team models [--run <id>]` (live resolution or stored snapshot); honor `--root` and default to `.team`.

### M2.5 — Tests and acceptance

- [x] Footer parser tests: every required key, missing footer, wrong case, last occurrence wins, malformed integers.
- [x] Gate table tests: one passing and one failing case for every row of SPEC §7.2, including `PASS` without `EXIT: 0`, `SKIPPED` with/without justification, spec not approved, blockers > 0.
- [x] State-machine tests: advance, rewind, loop cap at `maxLoops+1`, escalation, terminal state, statuses.
- [x] Run-resolution tests for every step in §7.6, including ambiguous and no-open-run cases.
- [x] Stack tests: one fixture file listing per marker-table row; monorepo; multi-language; repo-declared command precedence; empty directory → empty profile; resolution order; detection performs no commands/network (spies).
- [x] DB tests: fresh migration, upgrade, WAL, FTS triggers, trace never throwing with a broken DB.
- [x] Scripted integration test drives a run through every phase using fake artifacts and verifies every gate denial case.
- [x] `run_models` snapshot matches the M1 resolution result.
- [x] CLI smoke tests cover `team db migrate`, `team stack`, and `team models` against a temp DB.

**M2 exit gate**

- [x] A scripted run reaches `done`, including spec approval and all footer conditions.
- [x] Every gate denial case is verified.
- [x] Loop cap escalates at exactly `maxLoops + 1`.
- [x] Stack detection passes fixtures for every marker row.
- [x] Resolution order for profiles and runs is verified.
- [x] Typecheck and tests are green.

**Suggested commits:** `feat: add sqlite adapter and schema` → `feat: add artifact footers and phase gates` → `feat: add stack profile detection` → `feat: add run state machine tools` → `test: cover phase gates and stack profiles`.

---

## M3 — Gating hooks

**Goal:** enforce phase and scope rules in `tool.execute.before`, not just in prompts.

**Deliverables**

- `src/hooks/gate.ts`
- Path extractor and agent resolver in `compat.ts`
- Tests for every gate branch

### Work

- [x] Register the gate only when `gating.enabled` is true.
- [x] Always write a non-blocking `tool.before` trace; never let trace errors escape.
- [x] Implement the edit gate: if the tool is in `gating.editTools` and the run’s phase is before `implement`, block edits outside `<root>/` with the documented message.
- [x] Make the edit-tool set and input-path key extractor configurable, with the verified defaults; unknown shapes go through `compat.ts`.
- [x] Implement the scope gate from the run’s Stack Profile globs: `tester` only `globs.tests`, `docs` only `globs.docs`, `spec`/`retro` only under `<root>/`.
- [x] Use cross-language default globs when the profile has none and trace `gate.scope_default`.
- [x] If the event lacks an agent name, skip the scope gate and trace `gate.scope_skipped` once per run; rely on permissions and prompts.
- [x] Block `bash`/shell commands containing `team lessons approve` or `team prompts approve`; resolve the actual shell tool name and input key via M0 (V5).
- [x] Enforce unresolved-run policy: `gating.strict=true` throws; `false` allows and traces `gate.unresolved`.
- [x] Keep loop caps in `team_loop` / `team_rewind`, not in the gate.
- [x] Make every denial message actionable: state the phase, the rule, and the next tool call.
- [x] Ensure only intentional denials throw; all other gate errors are caught and traced.

### Acceptance

- [x] Editing a source file during `spec` is blocked with the documented message.
- [x] Editing a source file during `implement` is allowed.
- [x] Paths under `<root>/` are always allowed.
- [x] `tester` cannot edit source, only test globs; `docs` cannot edit source; defaults apply when globs are missing.
- [x] `gating.strict` behavior is verified for unresolved runs.
- [x] The CLI-approval bypass is blocked.
- [x] Gate tests cover each branch and both configured and default scopes.

**Suggested commits:** `feat: add phase and scope gate` → `test: cover gate decisions` → `feat: block CLI approval bypass`.

---

## M4 — Observability

**Goal:** every run, phase, tool call, gate decision, and loop is recorded and queryable; failures in tracing never fail the operation.

**Deliverables**

- `src/hooks/trace.ts` and `src/state/privacy.ts`
- `src/hooks/events.ts` if V9 is available
- Enriched `team_status`, `report.md`, and CLI: `team runs`, `team report`, `team trace`
- Session/message tables populated where the event stream allows

### Work

- [x] Implement `execute.after` tracing: tool, agent/session when available, run, phase, duration (match `before` by call ID), output bytes, `ok`, optional input/preview. A bounded LIFO span stack handles V18 nested calls that share call IDs.
- [x] Wrap the entire hook in try/catch; a broken DB must never turn a successful tool call into a failure.
- [x] Enforce privacy defaults: no input/output persistence unless enabled; redact common secret patterns when capture is on; truncate previews to `trace.previewChars`.
- [x] Subscribe to events if available: maintain sessions (`parent_id`, agent, run, start/end) and messages (model, tokens, cost) in the background. Do not block setup; abort the stream in cleanup.
- [x] If events are unavailable, derive sessions from tool executor contexts and document the gap; expose asynchronous stream failures as degraded status.
- [x] Extend `team_status` with recent events and useful counters.
- [x] Generate the full `report.md` when entering `retro`: phase durations, loops, gate denials, tool counts by tool/agent, notes, and token/cost by role/model when available.
- [ ] Implement CLI:
  - [x] `team runs [--open]`
  - [x] `team report <run>`
  - [x] `team trace <run> [--jsonl]`
- [x] Ensure trace export is stable JSONL and excludes secrets by default.
- [x] Add a test with a deliberately broken DB adapter asserting tool calls still succeed.

### Acceptance

- [x] After a scripted run, `team report` shows per-phase durations, tool counts, gate denials, and loops.
- [x] `team trace --jsonl` emits valid JSONL for tool calls and events.
- [x] Tracing failures never fail a tool call.
- [x] Privacy defaults are verified; redaction is tested when capture is enabled.
- [x] Event subscription cleans up without blocking setup; degraded mode is documented.

**Suggested commits:** `feat: trace tool calls` → `feat: subscribe to session and message events` → `feat: add report and trace cli` → `test: make tracing fail-safe`.

---

## M5 — Learning loop

**Goal:** retro lessons and prompt changes are proposed by agents, approved by humans, and injected into later requests within strict budgets.

**Deliverables**

- `team_lesson_propose` with validation and duplicate detection
- FTS ranking and request-hook lesson injection
- CLI lesson management and export
- Prompt proposals, approval flow, and reload
- Learning tests

### Work

- [x] Implement `team_lesson_propose`: role, text, optional evidence, optional stack (default `*`); status `proposed`; no agent-callable approval.
- [x] Validate lessons: 20–300 chars, actionable imperative sentence, role present; reject duplicates via FTS similarity and return the existing ID; cap proposals per run (default 10).
- [x] Implement lesson ranking: approved only; role + `*`; `stack_tag` in the run profile’s languages or `*`; FTS5 BM25 against run title/spec summary; fallback recency + hit count; stable order by rank then id.
- [x] Enforce `lessons.topN` (default 8) and `lessons.budgetChars` (default 4000); increment `hit_count`; trace injected lesson IDs.
- [x] Implement `inject-lessons` on the actual request/context hook: append the system section; support both string and structured `system` shapes through `compat.ts`; if the agent/role is unavailable, inject role-agnostic lessons only; never throw.
- [x] Keep the request hook fast (target < 10 ms typical) with indexed FTS and small N; no network calls in hooks.
- [ ] Implement CLI: `team lessons [--status proposed]`, `approve|reject|retire <id>`, `export`, and `stale` (report only).
- [ ] Implement prompt proposals: retro writes a complete proposed prompt to `<root>/proposals/<role>.<ts>.md`; record a `prompt_versions` row on transition out of retro (scan the directory) or via an edit hook if verified.
- [ ] Implement CLI: `team prompts list|approve|reject|diff`; approval moves the proposal to `<root>/prompts/<role>.md`, supersedes the previous version, and triggers reload via the verified mechanism (marker file or `ctx.agent.reload()`) or documents restart.
- [ ] Add an approved-prompt reload test or a documented restart path; ensure pending proposals are never used.
- [ ] Test: proposed lessons are never injected; approved are injected within `topN`/`budgetChars`; duplicate detection; stack filtering; stable ordering; role fallback; performance budget.

### Acceptance

- [ ] Proposed lessons are never injected; approved lessons are.
- [ ] Injection respects `topN`, `budgetChars`, role, stack tags, and stable order.
- [ ] Duplicates are rejected with the existing ID; per-run cap works.
- [ ] Approving a prompt changes the agent prompt after reload/restart, as documented.
- [ ] Agents have no approval path; CLI approval changes status and timestamps.
- [ ] Lesson export produces `<root>/lessons-export/<role>.md`.

**Suggested commits:** `feat: add lesson proposal and validation` → `feat: inject approved lessons` → `feat: add lesson cli` → `feat: add prompt proposal approval flow` → `test: cover learning loop`.

---

## M6 — Parallel worktrees and eval harness

**Goal:** optional parallel development and a repeatable way to compare prompt/model sets. The eval harness may ship as a documented stub if headless runs are impractical.

### M6.1 — Worktrees and concurrency

- [ ] Implement `team_worktree` only when `worktrees.enabled`; validate `name` against `^[a-z0-9-]{1,40}$`.
- [ ] Require a git repository; create with `git worktree add <baseDir>/<run>-<name> -b team/<run>/<name>` using an args array, never shell interpolation.
- [ ] In a non-git project, return a clear error; the lead falls back to sequential developers in place.
- [ ] Return the path; never delete worktrees automatically.
- [ ] Update the lead and developer prompts: the lead may run parallel developers; each developer calls `team_worktree` first and works only inside that path; the lead integrates branches in `implement` and records a decision note.
- [ ] Document that all worktrees share the main-repo DB and that the lead integrates branches in `implement`.
- [ ] Show leftover worktrees in `team runs` (via `git worktree list`) for manual cleanup.
- [ ] Concurrency test: two processes/workers write trace rows and advance different runs on one WAL DB without `SQLITE_BUSY` failures.

### M6.2 — Evals

- [ ] Define `evals/tasks/<name>/` with `task.md`, `fixture/`, and `criteria.json`.
- [ ] Implement the runner: copy the fixture to a temp dir, run the task headlessly when available, evaluate file/command/regex criteria, store `eval_runs`.
- [ ] Make the headless runner pluggable; if V12 has no reliable mechanism, ship a stub runner and document the gap.
- [ ] Store `prompt_set_sha` and `model_set_sha`; support `team eval run [task...]`, `team eval report [--by prompt_set_sha]`, and `--models <preset>`.
- [ ] Ship at least three fixtures on different ecosystems (e.g. TypeScript, Go, Python); criteria use the fixture’s own Stack Profile commands, not hardcoded commands.
- [ ] Report score, loops, and cost grouped by model set; allow comparison by `prompt_set_sha`.

### Acceptance

- [ ] Two worktrees are created for one run; concurrent writes succeed.
- [ ] Worktree creation is blocked cleanly outside git; no worktree is auto-deleted.
- [ ] The eval harness runs at least one fixture end to end, or ships as a documented stub with its interface tested.
- [ ] Three ecosystem fixtures exist and use their own Stack Profile commands.
- [ ] `team eval report` compares scores by prompt/model set.

**Suggested commits:** `feat: add worktree tool` → `test: verify wal concurrency` → `feat: add eval harness and fixtures` → `docs: document eval limitations`.

---

## M7 — Packaging, documentation, release

**Goal:** a clean project can install the package and follow the README verbatim.

### Work

- [ ] Finalize `package.json`: `type`, `exports`, `bin`, `files`, runtime `dependencies` for every import, `peerDependencies`/supported OpenCode range, semver version.
- [ ] Verify no native modules; all SQLite paths use `bun:sqlite` or `node:sqlite`.
- [ ] Write `README.md`: install, configuration options, quick start, illustrative model presets (placeholders only), worktree setup, approval workflow, reload/restart behavior, supported OpenCode range.
- [ ] Write `docs/architecture.md` from SPEC §3; keep `docs/api-notes.md` current with every deviation.
- [ ] Add `.gitignore` guidance: ignore `team.db*`, commit `prompts/` and `lessons-export/`.
- [ ] Run `npm pack`, install the tarball into a clean project, and load the plugin there.
- [ ] Verify the README quick start drives a toy task through `/team` and `team report`.
- [ ] Add release checklist: typecheck, tests, prompt-neutrality lint, clean-install smoke test, version bump, changelog.
- [ ] Note v1 non-goals and known limitations (no dashboard, no OTel, no auto-approval, worktrees optional).

### Acceptance

- [ ] Clean-project install loads the plugin.
- [ ] README quick start works verbatim.
- [ ] All runtime imports are declared.
- [ ] `npm pack` contains the intended files and no secrets/databases.
- [ ] Definition of Done from SPEC §20 is fully checked.

**Suggested commits:** `chore: finalize package metadata` → `docs: add install and usage guide` → `test: clean install smoke test` → `chore: release v0.1.0`.

---

## Cross-cutting workstreams

| Workstream | Rules | Milestones |
|---|---|---|
| **API compatibility** | All unverified/loose API shapes live in `src/compat.ts`; no `any` elsewhere; record deviations in `docs/api-notes.md`. | M0–M7 |
| **Hook safety** | Only the gate’s intentional denial throws; every other hook body is wrapped; trace failures are swallowed. | M3–M5 |
| **Privacy and security** | Names/sizes/timings by default; inputs/previews opt-in; redact secrets; process spawns use args arrays; validate names/paths. | M2–M6 |
| **Stack agnosticism** | No toolchain names in code/default prompts outside labeled examples; all commands come from the profile; denylist lint runs in CI. | M1–M7 |
| **Determinism** | Stable lesson order; deterministic run IDs/slugs; idempotent setup/migrations. | M2, M5 |
| **Documentation** | Every milestone updates `docs/api-notes.md`; README and architecture are release artifacts. | M0–M7 |
| **Logging** | Use the verified host logger; otherwise write warnings to `events`. No `console.log` noise in the TUI. | M0, M4 |
| **Quality gate** | Strict typecheck, full unit suite, plugin smoke test, and no red main at milestone boundaries. | every milestone |

## Test matrix

Map SPEC §16 to concrete files so nothing is forgotten.

| Area | Test file | Milestone |
|---|---|---|
| Config validation and defaults | `test/unit/config.test.ts` | M1 |
| Role table and disabled roles | `test/unit/roles.test.ts` | M1 |
| Prompt neutrality lint | `test/unit/prompts.test.ts` | M1 |
| Commands (`/team*`) | `test/unit/commands.test.ts` | M1 |
| Model resolution, fallback, params, diversity | `test/unit/models.test.ts` | M1 |
| Default export and setup registrations | `test/unit/plugin.test.ts` + `test/fakes/ctx.ts` | M1 |
| Footer parsing and artifact gates | `test/unit/artifacts.test.ts` | M2 |
| State machine, loops, escalation | `test/unit/state.test.ts` | M2 |
| Run resolution order | `test/unit/runs.test.ts` | M2 |
| Migrations, FTS triggers, WAL | `test/unit/db.test.ts` | M2 |
| Trace never throws | `test/unit/trace.test.ts` | M2, M4 |
| Stack detection and resolution order | `test/unit/stack.test.ts` + per-row fixtures | M2 |
| Gate decisions and scope | `test/unit/gate.test.ts` | M3 |
| Event ingestion, reports, and status counters | `test/unit/events.test.ts`, `report.test.ts`, `tools.test.ts` | M4 |
| CLI runs/report/trace | `test/unit/cli.test.ts` | M4 |
| Lesson validation, ranking, budget, duplicates | `test/unit/lessons.test.ts` | M5 |
| Prompt approval and injection | `test/unit/prompt-approval.test.ts` | M5 |
| Worktree validation and creation | `test/unit/worktree.test.ts` | M6 |
| WAL concurrency | `test/integration/concurrency.test.ts` | M6 |
| Eval harness and criteria | `test/unit/evals.test.ts` | M6 |
| Headless plugin integration | `test/integration/opencode.test.ts` | M0/M6, if V12 allows |
| Typecheck | `tsc --noEmit` in CI | all |

## Key decisions and gates

| Decision | When | Default | Fallback |
|---|---|---|---|
| Plugin package and entrypoint | M0 | Installed OpenCode resolution | Documented compatible package |
| Runtime and test runner | M0 | Bun + `bun test` | Node ≥22 + `vitest` |
| Agent fields for prompt/permission/model/params | M0 | Spec shapes | Compat wrappers; gate + prompts if permissions unavailable |
| Request/context hook name and `system` shape | M0 | Spec `request` | Actual verified hook; support string and array |
| Event stream availability | M0 | Subscribe if documented | Derive sessions from tool contexts; document gap |
| Headless eval mechanism | M0/M6 | Actual headless run | Pluggable stub runner |
| Prompt reload mechanism | M5 | `ctx.agent.reload()` | Restart-required path |
| Worktrees default | M6 | Disabled | Explicit opt-in only |
| Auto model routing | M1 | Disabled | Implement only if catalog metadata is reliable |
| Approval authority | M5 | Human CLI only | Never add an agent tool |

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| V2 plugin API drifts from the spec/current docs | High | High | M0 gate, pinned versions, `compat.ts`, record deviations; stop if no fallback exists. |
| Tool hook events lack session/agent/ID fields | High | Medium | Run-resolution fallbacks, skip scope gate with a trace, duration null. |
| Hook failures break intercepted operations | Medium | High | Fail-safe wrapper; intentional gate throws only; broken-DB test. |
| Host runtime lacks the assumed SQLite driver | Medium | High | Implement both adapters; test in the actual host in M0. |
| `SQLITE_BUSY` under parallel worktrees | Medium | High | WAL, busy timeout, one main-repo DB path, short transactions, concurrency test. |
| Event stream missing or unstable | Medium | Medium | Degrade to tool-context sessions; no blocking setup; document. |
| Headless OpenCode unavailable | Medium | Medium | Stub eval runner behind a pluggable interface; keep unit coverage. |
| Gate false positives block legitimate work | Medium | High | Default `strict=false`, allow `.team/`, clear messages, profile-driven scopes, allow overrides. |
| Prompt drift introduces stack assumptions | Medium | Medium | Denylist lint from M1; review prompts at every milestone. |
| Model catalog/params mismatch | Medium | Medium | Best-effort validation, filter params, fall back to inherit, never fail setup. |
| Lesson injection causes prompt bloat/cache churn | Medium | Medium | topN/budget caps, stable order, FTS index, performance test. |
| Scope creep from non-goals | Medium | Medium | Keep §19 out of v1; record ideas instead of implementing. |

## Definition of Done

Copy of SPEC §20, used as the final checklist:

- [ ] All milestones M0–M7 acceptance criteria met (M6 harness may be a documented stub if headless runs are impossible).
- [ ] `tsc --noEmit` and the full test suite pass.
- [ ] A clean-project install loads the plugin; `/team <goal>` drives a toy task through every phase with gates enforced; `team report <run>` produces the report; an approved lesson appears in a later run’s requests.
- [ ] `docs/api-notes.md` lists every resolved `[VERIFY]` and every deviation from the spec.
- [ ] Stack-agnostic demo completes end to end on fixtures in at least three ecosystems using each fixture’s own Stack Profile commands; the prompt-neutrality lint passes.
- [ ] Model routing demo applies different models per tier/role, `team models` shows it, `run_models` is stored, and `team report` breaks cost down by role/model when events are available.

## Non-goals (v1)

Do not build: web dashboard, OpenTelemetry exporter, TUI panels, multi-repo/multi-machine coordination, automatic prompt self-modification, agent-initiated approvals, v1 plugin API compatibility, or any of the ideas listed in SPEC §19.

---

## Appendix: API documentation drift to watch

Checked on 2026-10-29, the public V2 plugin docs live at `https://opencode.ai/v2/docs/build/plugins` and differ from some assumptions in SPEC draft v1.1. Treat this as a lead, not truth — the installed package types are authoritative.

- Docs show `import { Plugin } from "@opencode/plugin"` and `Plugin.define`, while the spec assumes `@opencode-ai/plugin/v2`. Verify the installed resolution (V1).
- `ctx.location.directory` and `ctx.location.project` appear to exist, which may resolve V16.
- The request hook is documented as `ctx.session.hook("context", ...)` with `event.agent` and `event.model`; `event.system` is a structured array, not necessarily a plain string. Verify and adapt (V7, V8).
- `ctx.event.subscribe({ types, signal })` returns an async iterable; abort it in cleanup (V9).
- Tool hooks are `execute.before` / `execute.after`; the docs show `event.tool` and `event.input` but do not document session/agent/tool-call IDs (V6).
- Tool definitions currently use `input` for the JSON schema and executors return content; the spec’s `jsonSchema`/`{ structured, content }` shape may need compat mapping (V10).
- The CLI may be `opencode`/`opencode2` depending on the installed release; verify `/api/plugin` and headless commands in M0 (V12).

Record every confirmed answer and every resulting deviation in `docs/api-notes.md`.
