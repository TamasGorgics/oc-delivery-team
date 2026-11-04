# Changelog

## 0.4.0

- Add per-role agent colors. Each role definition now has a `color`, and `ROLE_COLORS` supplies the default palette: `team-lead` `#8B5CF6`, `researcher` `#0EA5E9`, `spec` `#2563EB`, `developer` `#16A34A`, `tester` `#CA8A04`, `qa` `#DB2777`, `adversary` `#DC2626`, `docs` `#0D9488`, `retro` `#EA580C`.
- Add optional `roles.colors` overrides in plugin options. Keys must be known role ids and values six-digit hex (`#RRGGBB`); invalid or unknown entries and non-object values emit configuration warnings and fall back to the defaults. Agent registration sets `Agent.Info.color` from the override or the role default.
- Tests: 231 pass / 0 fail / 2,111 expect / 27 files; prompt tests 6 pass / 0 fail / 221 expect; typecheck clean. CI runs typecheck, tests, prompt-neutrality tests, and package verification.
- No database or schema change; schema version remains 3.

## 0.3.0

- Make the parallel review wave the default: `reviews.parallel` now defaults to `true`. An explicit `reviews.parallel:false` preserves the exact sequential `qa -> adversary -> docs` pipeline, including single-artifact gates, no `review.wave.*` events or non-empty role loop rows, the disabled `review_wave` shape, rewind to `adversary`, and unchanged base prompts.
- Register `team_worktree` in every plugin catalog, including default and non-Git projects. `worktrees.enabled` still defaults to `false` and now gates creation only. Disabled calls return `worktrees_disabled`; enabled non-Git and missing-Git calls return `not_git_repository` and `git_unavailable`. All three tell the lead to continue sequentially in the main checkout and not retry. Enabled creation, worktree path/branch layout, and conflict behavior are unchanged.
- Skip disabled review roles: with `qa` and/or `adversary` in `roles.disabled`, the effective wave is off, advances omit that reviewer's artifact and report `skipped`, status reports that no review artifact is required, and `team_rewind` to a disabled review role is rejected with `review_role_disabled`.
- Fix the disabled-reviewer artifact trap that required an artifact from an unregistered reviewer; remove the unconditional `## Disabled review roles` section from the base prompts; add sequential-fallback wording to the creation-path `git_unavailable` error; dedupe `reviews.parallel` warnings.
- Dogfood: this run used the default wave at generation 3. QA (`ses_e5caf6ddaffeb28HpRrjDXetR9`, epochs `1793741328977`–`1793741605753`) and adversary (`ses_e5caf6dd9ffeLYotYo70rNWCMl`, `1793741331391`–`1793741895501`) overlapped ~276 s (4.6 min); `review.wave.completed` recorded `601159` ms; the run advanced directly `qa -> docs` with `adversary` skipped.
- Tests: 228 pass / 0 fail / 2061 expect / 27 files; prompt tests 6 pass / 221 expect. CI runs typecheck, tests, prompt-neutrality tests, and package verification.
- Known limitations: stale review artifacts after a rewind can make the barrier ready immediately; worktrees are never cleaned up automatically; disabled non-review roles can still own a phase with no registered agent and trap a run (pre-existing); an approved local prompt override may be stale relative to new built-in wording.

## 0.2.0

- Add the optional `reviews.parallel` review wave: `qa` becomes a two-artifact barrier (`qa.md` with `VERDICT: PASS`, `adversary.md` with `BLOCKERS: 0`), a passing barrier advances directly `qa -> docs`, and the `adversary` phase is skipped. The default remains the sequential `qa -> adversary -> docs` pipeline.
- Add role-scoped loop counters `(run_id, phase, role)` and migration 3. The migration rebuilds `loops`, aggregate-copies legacy counts into `role=''`, verifies the primary key, repairs drifted tables, and rechecks applied versions inside the transaction.
- Add `review.wave.started|denied|completed` events, the additive `review_wave` status payload with member gates/loops and `generation`, `role_loops`, role-qualified report loops, and a `## Review wave` report section.
- Add conditional parallel-review guidance for `team-lead`, `qa`, `adversary`, and `docs` only when the option is enabled; built-in prompt bodies and disabled effective prompts are unchanged.
- Add barrier/fallback/rewind/config/report/prompt tests, migration 3 upgrade and drifted-table tests, and a two-process WAL review concurrency test.
- Known limitations: stale passing review artifacts after a rewind to `qa` can make the barrier ready immediately; host child-session overlap was verified in a two-session spike (~10.45s), while provider rate limits or host scheduling can still serialize reviewers and the supported fallback remains sequential reviewers in `qa`; concurrent duplicate `team_advance` calls can duplicate a transition; migration 3 fails safely and rolls back on orphan loop rows; reviewer artifact ownership is prompt-level; `v1.0.0` remains blocked on manual `/team` verification.

## 0.1.8

- Require every role to create its artifact early, before deep exploration.
- Increase review-role budgets: researcher and QA to 40, adversary to 60, retro to 40.
- Reduce repeated step-limit failures before artifact persistence.

## 0.1.7

- Make commit ownership explicit: developers commit verified changes; the lead never commits or runs git.
- Add a focused developer retry when a step limit occurs after edits but before committing.
- Update prompts, architecture notes, and regression coverage.

## 0.1.6

- Raise the docs agent step budget from 20 to 40.
- Require the docs agent to create `docs.md` before deep exploration and write documentation files directly.
- Prohibit deterministic scripts and patch generators as scribe substitutes for artifacts.
- Add prompt and role-budget regression coverage.

## 0.1.5

- Allow root-scoped artifact roles to write both the absolute `<root>/**` pattern and the project-relative `<root>/**` pattern.
- Fix blocked artifact writes for researcher, spec, QA, adversary, and retro roles.
- Add regression coverage for relative and absolute root permission patterns.

## 0.1.4

- Block the built-in read-only `plan` agent during active delivery runs.
- Make the plan phase verification-only; `spec` owns `plan.md` and is re-dispatched only when it is missing.
- Add plan-specific next-action guidance and prevent draft compilation or scribe fallbacks.
- Add gate, prompt, and status regression tests.

## 0.1.3

- Add explicit phase-to-role ownership, with both `spec` and `plan` owned by the `spec` subagent.
- Prevent the lead from launching the built-in read-only `plan` agent or using a scribe role.
- Expose the current phase owner in `team_status` and blocked next actions.
- Document the ownership map in the README and architecture guide.

## 0.1.2

- Raise the spec agent's step budget from 20 to 40 for its two artifacts.
- Require the spec agent to create `spec.md` and `plan.md` before deep exploration.
- On a step-limit failure, retry the same role with the exact artifact path instead of using a scribe role.
- Keep artifact writes restricted to the run directory.

## 0.1.1

- Correct GitHub-based installation and upgrade instructions; no local checkout or project `node_modules` is required.
- Run typecheck, the full test suite, prompt-neutrality checks, and package verification in GitHub Actions CI.
- Add Code Mode guidance to every effective prompt, including approved prompt overrides.
- Enforce exact run artifact paths and prevent one role from persisting another role's artifact.
- Move the specification and roadmap under `docs/` and keep them out of the published package.

## 0.1.0

Initial release.

- Nine role agents with stack-agnostic prompts and configurable model routing.
- Phase state machine, artifact footers, gates, loops, rewinds, and reports.
- SQLite persistence through Bun or Node SQLite adapters.
- Table-driven Stack Profile detection and command resolution.
- Human-only CLI for runs, reports, traces, lessons, prompts, worktrees, and evals.
- Approved-lesson ranking, injection budgets, proposal validation, and exports.
- Prompt proposal discovery, diffing, approval, supersession, and restart-based loading.
- Optional Git worktrees with shared WAL database support and manual cleanup.
- Pluggable fixture eval harness with TypeScript, Go, and Python tasks.
