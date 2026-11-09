# Tests

## Approach and harness

- Prefer integration tests; use unit tests when recreating a case through the harness is prohibitively complex. Follow an existing spec for the same area before extending test infrastructure.
- Integration specs use a fresh `TestHarness`, compiled binary, temporary environment, fake keychain, and fake servers. Dispose the harness in `afterEach`. Use its state builder and existing Git helpers rather than hand-rolling fixtures.
- Reuse `tests/integration/harness/recording-stub.ts` for external-binary fixtures: compiled stubs run on Windows, and per-executable configuration prevents secrets/SCA stubs from sharing settings.
- Use `run()` for commands, `runWithStdin()` for piped input, and `runInteractive()` for prompt flows. Prompts gated by `console.canPrompt()` need `SONARQUBE_CLI_MOCK_TTY=1`; the harness does not create a real terminal. It disables browser launches by default.
- Unit command tests inject `FakeConsole` from `tests/_common/fake-console.ts`; use `setCanPrompt(false)` for noninteractive cases. Use the shared keychain test handle rather than the real keychain.
- Keep integration tests deterministic with fake network, keychain, and temporary files. E2E tests cover required real external dependencies; follow sibling specs' environment-variable skip behavior.
- Run `bun run pretest:integration` once before iterating with `bun test <file>`; unit files need no setup. Use `bun run test:coverage` or `test:coverage:unit`, never `bun test --coverage`: native LCOV mislabels non-executable lines.

## Telemetry isolation — all four safeguards are required

- Spawn the CLI through the harness or spread `ISOLATED_CLI_SPAWN_ENV` from `tests/_common/isolated-cli-env.ts`. It disables egress; hand-rolled spawns otherwise inherit production transmission.
- Every unit test enabling telemetry must set `SONAR_USER_HOME` to a temporary directory. Egress off still writes queued events; a later real CLI command could transmit a developer's queue.
- When clearing `__SQ_CLI_TELEMETRY_EGRESS` to exercise workers/draining, mock **both** `Bun.spawn` and the network transport in the same test file.
- Direct calls to `flushTelemetryEvents()` require the network transport mocked: its guard exists only in `flushTelemetry()`.

Use the shared isolated preload/spawn environment. `withTelemetryEnabled()` does not require `__SQ_CLI_TELEMETRY_FLUSH__=1`; that switch bypasses fact committing and breaks command-event assertions. Reset ambient project-UUID context between tests that use it. Read [telemetry guidance](../src/core/telemetry/AGENTS.md) for lifecycle changes.
