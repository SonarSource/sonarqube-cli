# Tests

## Philosophy

**Integration tests are the default.** Unit tests are justified only when a situation is genuinely hard to recreate via integration tests due to test setup complexity. Before writing a unit test, first consider extending the harness or fake server infrastructure to handle the scenario. Unit tests are a last resort.

Follow the structure of existing tests for the command or feature area you are working in.

- Unit tests: `tests/unit/` — inject `FakeConsole` (`tests/_common/fake-console.ts`) via `CommandInvocationContext` / `SonarCommand({ console })`. Use `tests/unit/core/host/keychain-test-handle.ts` for keychain.
- Integration tests: `tests/integration/specs/<command>/` — run the compiled binary against fake servers. Use `TestHarness` from `tests/integration/harness/`.
- E2E tests: `tests/e2e/` — real external dependencies that cannot be faked: OS keychain, install scripts with real network, real SonarQube server calls, and integration with external tools. Those tests are black-box tests and exercise the product from the outside. `tests/e2e/context/context-augmentation.test.ts` covers the live `sonar-context-augmentation` install: it seeds CAG state in `state.json` and lets `runPostUpdateActions()` download, PGP-verify, and extract the real archive from `binaries.sonarsource.com`. Post-update skill→hook refresh, missing-root / multi-root / no-op / stale-binary cleanup, and integrate skip paths live in integration tests (`post-update.test.ts`, `context-augmentation.test.ts`) against the CAG stub or the fake binaries server. The happy-path `sonar integrate` + real CAG daemon is not covered under the harness: CAG's daemon socket path exceeds the AF_UNIX limit under the harness `tmpdir` layout. Shared e2e scaffolding lives in `_helpers.ts`. Cloud-mode CAG in the Claude Code e2e talks to the fake server as `api.localhost` (CAG-933); CI pins that name to loopback in `.github/actions/run-integration-and-e2e` because Windows and some self-hosted Linux images do not resolve `*.localhost`.

Before writing a test, find an existing spec for the same command area and follow its structure.

## Integration test harness

Each test creates a fresh `TestHarness` and disposes it in `afterEach`. The harness runs the compiled binary in a fully isolated environment (temp dir, fake keychain, fake servers). For fine-grained state setup beyond `withAuth`, use `harness.state()` builder (see `tests/integration/harness/environment-builder.ts`). For git hook tests, use `initGitRepo` / `stageFile` from `tests/integration/specs/hook/git-test-helpers.ts`. Use `harness.run()` for non-interactive commands. Use `harness.runWithStdin()` to dump stdin and wait for exit. Drive prompt-by-prompt flows with `harness.runInteractive()`, which returns an `InteractiveSession` (`waitText`, `accept` / `decline`, `write` / `keyEnter` / `keyUp` / `keyDown` / `keySpace` / `keyCtrlC`, then `waitFinish()`). `dispose()` kills any session that is still running.

## Coverage

To run tests with coverage and produce the LCOV reports consumed by SonarQube, use:

```bash
bun run test:coverage        # full pipeline: unit + integration + merge
bun run test:coverage:unit   # unit only (faster, no binary build needed)
```

Do **not** use `bun test --coverage` directly — Bun's native LCOV reporter emits spurious entries on non-executable lines (signatures, braces, blank lines) that cause false positives in SonarQube.

## Telemetry in tests

A test that touches telemetry can reach the production backend if set up wrong. See "Writing tests that touch telemetry" in `src/core/telemetry/CLAUDE.md` before writing one.
