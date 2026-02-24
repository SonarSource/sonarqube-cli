# About this project

A CLI tool (`sonar`) that integrates SonarQube and SonarCloud into developer workflows.

# Running checks

```bash
npm run lint          # ESLint (TypeScript-aware)
npm run lint:fix      # Auto-fix safe issues
npm run typecheck     # tsc --noEmit
npm test              # Unit tests (bun test)
npm run test:all      # Unit + integration + script tests
```

# Writing code

- Always fix TypeScript errors before considering a task done.
- Never attempt to fix linting issues until the implementation is correct.
- Use `import type` for type-only imports.
- **MANDATORY**: After editing any `.ts` file, run `npx prettier --write <file>` to ensure consistent formatting. Or run `npm run format` to format all source files at once.

## Commands

Each command lives in `src/commands/`. Commands are registered in `src/index.ts` (generated — do not edit manually).

To add a new command: `npm run gen:command` and follow the prompts. Then implement the logic in the generated file.

## Error handling

Use `runCommand()` from `src/lib/run-command.ts` to wrap command handlers — it provides consistent error handling and exit codes.

## State and auth

- Persistent state (server URL, org, project) is managed via `src/lib/state-manager.ts`.
- Tokens are stored in the system keychain via `src/lib/keychain.ts` — never store tokens in plain files.
