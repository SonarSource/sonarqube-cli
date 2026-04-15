# About this project

A CLI tool (`sonar`) that integrates SonarQube Server and Cloud into developer workflows.

# Running checks

Use the package.json scripts for full test runs.

```bash
bun run lint              # ESLint (TypeScript-aware, includes import sort)
bun run lint:fix          # Auto-fix safe issues
bun run typecheck         # tsc --noEmit
bun run test:unit         # All unit tests
bun run test:integration  # All integration tests, no coverage (local development)
bun run test:all          # Unit + integration
bun run test:e2e          # E2E tests (install scripts, requires network)
bun run test:coverage     # Full merged lcov report (unit + integration, slow)
bun run test:e2e:coverage # E2E tests with coverage (appends to integration lcov)
```

### Running a single test file

- **Unit**: `bun test <file>` — no setup needed.
- **Integration**: run `bun run pretest:integration` once first (builds binary, sets up resources), then `bun test <file>` as many times as needed.

# Writing code

- Always fix TypeScript errors before considering a task done.
- Never attempt to fix linting issues until the implementation is correct.
- Use `import type` for type-only imports.
- **MANDATORY**: After editing any `.ts` file, run `bun run format` to format all source files at once, or `bun x prettier --write <file>` for a single file.

## Commands

Each command lives in `src/cli/commands/`. The command tree is defined in `src/cli/command-tree.ts` and the entry point is `src/index.ts`.

To add a new command: add it to `src/cli/command-tree.ts` and implement the logic in a new folder under `src/cli/commands/`.
Please declare commands using the type defined in `src/cli/commands/_common/sonar-command.ts`.
By default, new commands should register a `authenticatedAction()`, only technical commands will use `anonymousAction()`.

## Error handling

Please use the exception types defined in `src/cli/commands/_common/error.ts` for production code. If you need to throw an error from a mock in test code, it's fine to use the generic `Error` type.

## State and auth

- Persistent state (server URL, org, project) is managed via `src/lib/state-manager.ts`.
- Tokens are stored in the system keychain via `src/lib/keychain.ts` — never store tokens in plain files.
- All path and URL constants live in `src/lib/config-constants.ts` — import from there instead of hardcoding.
- Caller-agent hints (Cursor vs Claude Code) from the environment: `src/lib/agent-detector.ts` (`detectCallerAgent`, etc.).
- `sonar auth logout` relies on state: if there is no active connection or `isAuthenticated` is false, it only reports that you are already logged out (no keychain changes).

## Tests

Always prefer end-to-end integration tests. Unit tests are a last resort — only when e2e is genuinely impractical (e.g. the dependency cannot be controlled or isolated at all).
Try to get inspiration from other tests to follow the same structure.

- Unit tests: `tests/unit/` — run with `bun test:unit`
- Integration tests: `tests/integration/` — require env vars. They are using a harness to help set up tests and make assertions. Run with `bun test:integration`.
- E2E tests: `tests/e2e/` — end-to-end tests to verify full integration with external systems. Run with `bun test:e2e`.
- The UI module has a built-in mock system (`src/ui/mock.ts`) — use it instead of mocking stdout directly.

## Documentation

When adding, removing, or changing commands, scripts, or project structure, update `CLAUDE.md`, and `AGENTS.md` to reflect the change before finishing.

## Docs site (`docs/`)

The docs site is generated from the CLI source — do not edit `commands.json`, `commands.js`, `llms.txt`, or `sitemap.xml` by hand.

**Source of truth:**
- Command structure → `src/cli/command-tree.ts`
- Examples → `build-scripts/examples.ts`
