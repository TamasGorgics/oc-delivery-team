# OpenCode V2 API notes

Status: M0 discovery in progress. This file is filled in during M0.2; entries below are verified during M0.1.

## Toolchain

| Item | Value | Source |
|---|---|---|
| OpenCode | `2.2.0` | `opencode --version`; `ctx.app.version` from the hello probe |
| Plugin SDK/types | `@opencode/plugin@2.2.0` | installed package |
| Host runtime | Bun `1.4.4` | `Bun.version` reported by the hello probe |
| Development/test runtime | Bun `1.4.4` | `bun --version` |
| Test runner | `bun test` | project decision; no Vitest |
| Plugin entrypoint | Promise API from `@opencode/plugin` | `node_modules/@opencode/plugin/dist/promise` |
| Schema/runtime types | `effect@4.0.1` (peer + dev) | host provides `effect` at runtime; SDK README |

### Deviations from SPEC

- SPEC names `@opencode-ai/plugin/v2`; the installed OpenCode `2.2.0` resolves `@opencode/plugin` (default export path is the Promise API). Pin `@opencode/plugin@2.2.0`.
- Actual tool declaration uses `input` / `output` schemas, not `jsonSchema`.
- Actual Promise tool result shape is `{ output?, content?, metadata? }`; `content` is `string | Content[]`.
- Actual Promise tool context fields are `sessionID`, `agent`, `messageID`, `id`, `signal`, `progress` (not `assistantMessageID` / `toolCallID`).

## Local development loading

- Local discovery path: `.opencode/plugins/hello/` (immediate child directory with `index.ts`).
- Verified with `opencode plugin list`:

  ```
  ID     VERSION  SOURCE
  hello  local    /Users/tamas/projects/oc-delivery-team/.opencode/plugins/hello
  ```

- `opencode --standalone api get /api/plugin` returned `{"location":...,"data":[]}` for a one-shot private server even though `opencode plugin list` and the live session loaded `hello`. A long-running `opencode serve` returns `hello` as `{"id":"hello","source":{"type":"local","path":"..."},"state":{"status":"active"}}` from `/api/plugin`. Treat the one-shot result as lazy initialization, not proof of failure.
- `opencode --server ... api get /api/tool` returns `404`; tool visibility is through `/api/plugin` and the model tool catalog.
- Planned M1 loading path: root `opencode.jsonc` with a local `plugins` entry for the package. Keep `.opencode/plugins/hello/` through M0.2, then remove it at the M0 exit gate.

## Verified in M0.1

- `Plugin.define({ id: "hello", setup })` loaded from `.opencode/plugins/hello/index.ts`.
- `ctx.tool.transform((tools) => tools.add(...))` registered `greeting`.
- Calling `greeting` from this session returned `Hello, M0.1!`; the result carried `runtime: bun 1.4.4` and `appVersion: 2.2.0`.
- A headless run (`opencode --standalone run ...`) loaded the plugin, called `greeting`, and the model replied with the exact tool result.
- Setup receives `ctx.app`, `ctx.location.directory`, and `ctx.options`.
- Cleanup runs on host unload: the headless run logged `[hello] cleanup` on `SIGTERM`.
- Cleanup and re-setup run on configuration reload: `opencode reload` logged `cleanup` for the old setup followed by a new `setup` and `tool-registered`.
- The plugin setup cleanup is a returned function; the unit test also verifies repeated setup and idempotent cleanup.

## Open items for M0.2

- V1–V17 answers and sources.
- Why `opencode plugin list --server ...` reports "No plugins found" while `/api/plugin` reports `hello`.
- Tool hook event names and payloads; request/context hook; agent transform; catalog shapes.
- SQLite driver behavior in the real plugin host.
