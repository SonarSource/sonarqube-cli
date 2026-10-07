# Tests

`tests/integration/specs/onboard/onboard.test.ts` covers first-analysis onboarding using a compiled SonarScanner Java stub (`resources/sonar-scanner-stub.ts`) for scan execution and the real, pinned platform archive for installation/extraction/JRE verification and importing custom CA bundles through Java without a keytool executable, covering both SONAR_CA_CERT and NODE_EXTRA_CA_CERTS. `pretest:integration` prepares both fixtures; the fake binaries server serves scanner ZIPs alongside existing dependency artifacts. Real scanner bootstrap regression tests use its offline simulation mode to validate endpoint arguments against inherited region settings without contacting external services. Tests verify that Maven, Gradle, and .NET build markers all use Scanner CLI with automatic configuration enabled and that command-line opt-in overrides a local opt-out without editing the properties file. Scanner-property tests cover repeated settings, duplicate precedence, empty values, spaces and additional equals signs, preservation of local configuration, and rejection of malformed or command-managed settings before installing or creating a project. Output tests cover successful repeated onboarding without scanning, existing Cloud project warnings and dashboard links in text and JSON, quiet default output, verbose logs arriving before scanner exit, redaction across chunk boundaries, JSON verbose logs routed to stderr, and text defaults for human and agent callers, active-issue pagination, wrapped messages, redacted log files, and non-fatal issue/quality-gate retrieval failures. The stub records arguments and child authentication to a harness-local log; it never contacts external services.

`tests/integration/specs/onboard/detach.test.ts` verifies that background workers outlive the parent, keep credentials off arguments/logs/status files, retain TLS work files until completion, preserve the invocation auth/network snapshot, record scan/processing failures, clean working directories, and launch in both compiled and source modes. The shared scanner opt-in and custom scanner properties are verified in background execution too. Tests wait for each worker to finish before disposing its fake server and temporary home.

## Philosophy

**Integration tests are the default.** Unit tests are justified only when a situation is genuinely hard to recreate via integration tests due to test setup complexity. Before writing a unit test, first consider extending the harness or fake server infrastructure to handle the scenario. Unit tests are a last resort.

Follow the structure of existing tests for the command or feature area you are working in.

- Unit tests: `tests/unit/` — inject `FakeConsole` (`tests/_common/fake-console.ts`) via `CommandInvocationContext` / `SonarCommand({ console })`. Use `tests/unit/core/host/keychain-test-handle.ts` for keychain.
- Integration tests: `tests/integration/specs/<command>/` — run the compiled binary against fake servers. Use `TestHarness` from `tests/integration/harness/`.
- E2E tests: `tests/e2e/` — real external dependencies that cannot be faked: OS keychain, install scripts with real network, real SonarQube server calls, and integration with external tools. Those tests are black-box tests and exercise the product from the outside. `tests/e2e/context/` is the offline real-binary suite for `sonar-context-augmentation`: it seeds CAG state in `state.json`, lets `runPostUpdateActions()` re-download CAG from `binaries.sonarsource.com`, and covers post-update refresh (`cag-offline.test.ts`), edge cases like missing project roots / global skills / multi-skill refresh / stale-binary cleanup (`cag-edge-cases.test.ts`), passthrough behaviors including unauthenticated errors and exit-code propagation (`cag-passthrough.test.ts`), the `copilot-cli` skill path (`cag-copilot.test.ts`), the `codex` skill path (`cag-codex.test.ts`), and `sonar integrate` pre-flight skip paths against a fake server — SonarQube Server connections and disabled entitlement (`cag-integrate.test.ts`; the happy path is deferred because CAG's daemon socket path exceeds the AF_UNIX limit under the harness `tmpdir` layout). Shared scaffolding lives in `_helpers.ts`. No SonarQube/Cloud access required — only the binaries CDN. Cloud-mode CAG talks to the fake server as `api.localhost` (CAG-933); CI pins that name to loopback in `.github/actions/run-integration-and-e2e` because Windows and some self-hosted Linux images do not resolve `*.localhost`.

Before writing a test, find an existing spec for the same command area and follow its structure.

## Integration test harness

Each test creates a fresh `TestHarness` and disposes it in `afterEach`. The harness runs the compiled binary in a fully isolated environment (temp dir, fake keychain, fake servers). For fine-grained state setup beyond `withAuth`, use `harness.state()` builder (see `tests/integration/harness/environment-builder.ts`). For git hook tests, use `initGitRepo` / `stageFile` from `tests/integration/specs/hook/git-test-helpers.ts`. Use `harness.run()` for non-interactive commands. Use `harness.runWithStdin()` to dump stdin and wait for exit. Drive prompt-by-prompt flows with `harness.runInteractive()`, which returns an `InteractiveSession` (`waitText`, `accept` / `decline`, `write` / `keyEnter` / `keyUp` / `keyDown` / `keySpace` / `keyCtrlC`, then `waitFinish()`). `dispose()` kills any session that is still running. The harness sets `SONARQUBE_CLI_DISABLE_BROWSER=true`, so interactive auth tests can use `CI=false` without launching the developer's browser.

## Coverage

To run tests with coverage and produce the LCOV reports consumed by SonarQube, use:

```bash
bun run test:coverage        # full pipeline: unit + integration + merge
bun run test:coverage:unit   # unit only (faster, no binary build needed)
```

Do **not** use `bun test --coverage` directly — Bun's native LCOV reporter emits spurious entries on non-executable lines (signatures, braces, blank lines) that cause false positives in SonarQube.

## Telemetry in tests

A test that touches telemetry can reach the production backend if set up wrong. See "Writing tests that touch telemetry" in `src/core/telemetry/CLAUDE.md` before writing one.
