# Changelog

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
- Add a GitHub Actions CI workflow for typechecking, tests, prompt neutrality, and package-manifest checks.
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
