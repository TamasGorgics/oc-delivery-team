# Release checklist

Run these checks from a clean checkout before tagging a release.

## 1. Repository checks

```sh
export PATH="$HOME/.bun/bin:$PATH"
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:prompts
git diff --check
git status --short
```

The full test suite includes the prompt-neutrality lint, gate, state, migration, learning-loop, worktree, and eval coverage. The working tree must be clean before tagging. The `.github/workflows/ci.yml` workflow runs the same checks on pushes and pull requests; it must be green before release.

## 2. Package manifest

```sh
npm pack --dry-run --json --ignore-scripts
```

Confirm the tarball contains only:

- `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`
- `src/`
- `evals/`
- `docs/`

Confirm it does not contain `test/`, `.opencode/`, `.team/`, `node_modules/`, `docs/SPEC.md`, `docs/ROADMAP.md`, or `bun.lock`. Confirm no database, secret, or local configuration file is present.

## 3. Clean-install smoke test

Create a directory outside this repository. Install the generated tarball in a fresh project and configure `opencode.json` with the local package path:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./node_modules/opencode-delivery-team",
      "options": { "root": ".team" }
    }
  ]
}
```

Start OpenCode and verify:

- the plugin appears in `/api/plugin` for a global install, or all nine role agents and the `team`, `team-status`, and `team-retro` commands appear for a project install;
- `team runs`, `team report`, and `team db migrate` work from the installed package;
- a toy `/team` run reaches at least the first gated phase;
- `team report <run>` renders the Markdown report.

Also repeat the check using the public GitHub install paths from the README:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:TamasGorgics/oc-delivery-team#vX.Y.Z",
      "options": { "root": ".team" }
    }
  ]
}
```

Confirm the same agents/commands load with no repository checkout. Then verify:

```sh
opencode plugin add 'github:TamasGorgics/oc-delivery-team#vX.Y.Z'
npm install --global 'github:TamasGorgics/oc-delivery-team#vX.Y.Z'
team --help
npx --yes --package 'github:TamasGorgics/oc-delivery-team#vX.Y.Z' team --help
```

A model-provider call is required for the full quick-start check. If the provider is unavailable, record the limitation and do not mark the quick-start acceptance complete; still verify plugin loading and CLI paths without a model.

## 4. Definition of Done audit

Verify SPEC §20:

- M0–M7 acceptance criteria are checked.
- Typecheck and the full test suite pass.
- Clean-project install loads the plugin and the README quick start works.
- An approved lesson appears in a later run's injected context.
- The three ecosystem eval fixtures use their own Stack Profile commands.
- The prompt-neutrality test passes.
- Model routing can be inspected with `team models` and appears in the stored run snapshot and report.
- `docs/api-notes.md` records resolved `[VERIFY]` items and deviations.

## 5. Release housekeeping

1. Update `CHANGELOG.md`.
2. Confirm the semver version in `package.json`.
3. Ensure `.team/team.db*` is ignored and approved prompts/exports are tracked.
4. Commit as `chore: release vX.Y.Z`.
5. Create the tag only after the clean-install smoke test passes.

Do not publish the package as part of an automated test. Publishing is a separate human decision.
