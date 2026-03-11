# About this project

A CLI tool (`sonar`) that integrates SonarQube Server and Cloud into developer workflows.

# Running checks

```bash
bun run lint          # ESLint (TypeScript-aware, includes import sort)
bun run lint:fix      # Auto-fix safe issues
bun run typecheck     # tsc --noEmit
bun test              # Unit tests
bun run test:all      # Unit + integration + script tests
```

# Writing code

- Always fix TypeScript errors before considering a task done.
- Never attempt to fix linting issues until the implementation is correct.
- Use `import type` for type-only imports.
- **MANDATORY**: After editing any `.ts` file, run `bun run format` to format all source files at once, or `bun x prettier --write <file>` for a single file.

## Commands

Each command lives in `src/cli/commands/`. The command tree is defined in `src/cli/command-tree.ts` and the entry point is `src/index.ts`.

- `sonar integrate claude` — Setup for Claude Code (hooks + MCP).
- `sonar integrate git` — Install a git hook that scans staged files for secrets before each commit (`pre-commit`) or scans committed files for secrets before each push (`pre-push`). If `.pre-commit-config.yaml` exists, the hook is added there and `pre-commit install` is run; else if `.husky/pre-commit` or `.husky/pre-push` exists (for the matching hook type), the check is appended there; otherwise a raw script is written to `.git/hooks/`. Use `--hook`, `--force`, `--non-interactive` as needed. Shows inline status at the end. Use `--global` to install a hook globally (sets `git config --global core.hooksPath` to `~/.sonar/sonarqube-cli/hooks`).
- `sonar integrate git test` — Run a quick test to verify the hook blocks a commit whose staged files contain a secret.

To add a new command: add it to `src/cli/command-tree.ts` and implement the logic in a new file under `src/cli/commands/`.

## Error handling

Use `runCommand()` from `src/lib/run-command.ts` to wrap command handlers — it provides consistent error handling and exit codes. Never handle errors manually in command handlers.

## State and auth

- Persistent state (server URL, org, project) is managed via `src/lib/state-manager.ts`.
- Tokens are stored in the system keychain via `src/lib/keychain.ts` — never store tokens in plain files.
- All path and URL constants live in `src/lib/config-constants.ts` — import from there instead of hardcoding.

## Tests

Please try to create integration tests in priority. If the test is too complicated to set up, write unit tests.
Try to get inspiration from other tests to follow the same structure.

- Unit tests: `tests/unit/` — run with `bun test`
- Integration tests: `tests/integration/` — require env vars. They are using a harness to help set up tests and make assertions.
- The UI module has a built-in mock system (`src/ui/mock.ts`) — use it instead of mocking stdout directly.

## Documentation

When adding, removing, or changing commands, scripts, or project structure, update `CLAUDE.md`, and `AGENTS.md` to reflect the change before finishing.
