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

To add a new command: add it to `src/cli/command-tree.ts` and implement the logic in a new file under `src/cli/commands/`.

## Error handling

Use `runCommand()` from `src/lib/run-command.ts` to wrap command handlers — it provides consistent error handling and exit codes. Never handle errors manually in command handlers.

## State and auth

- Persistent state (server URL, org, project) is managed via `src/lib/state-manager.ts`.
- Tokens are stored in the system keychain via `src/lib/keychain.ts` — never store tokens in plain files.
- All path and URL constants live in `src/lib/config-constants.ts` — import from there instead of hardcoding.

## Tests

- Unit tests: `tests/unit/` — run with `bun test`
- Integration tests: `tests/integration/` — require env vars, skipped locally by default
- The UI module has a built-in mock system (`src/ui/mock.ts`) — use it instead of mocking stdout directly.

## Documentation

When adding, removing, or changing commands, scripts, or project structure, update `CLAUDE.md`, and `AGENTS.md` to reflect the change before finishing.
