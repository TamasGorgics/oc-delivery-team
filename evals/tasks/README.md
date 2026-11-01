# Evaluation tasks

Each task directory contains `task.md`, `fixture/`, and `criteria.json` (version 1).

Criteria are weighted and use one of these types:

- `file_exists`: `{ "id", "type": "file_exists", "path", "weight?" }`
- `regex`: `{ "id", "type": "regex", "path", "pattern", "flags?", "weight?" }`
- `stack_command`: `{ "id", "type": "stack_command", "key": "test", "expectedExitCode?", "timeoutMs?", "weight?" }`

Paths are relative to the copied fixture and may not escape it. A `stack_command` criterion resolves the named command from that fixture's Stack Profile and runs it as a single argv command (shell operators are rejected). Scores are weighted percentages from 0 to 100.

`team eval run` executes the fixture and Stack Profile commands in a temporary copy. Treat fixtures as executable code and run only tasks you trust. Automated tests inject a deterministic fake headless runner; a real evaluation uses the OpenCode CLI and requires a configured model/provider.
