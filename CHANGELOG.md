# Changelog

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
