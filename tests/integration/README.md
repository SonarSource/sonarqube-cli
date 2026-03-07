# Integration Tests

Integration tests verify real CLI behaviour by spawning the compiled binary in an isolated
environment. Most tests require no external services or credentials.

## Running Tests

```bash
# Integration tests only
bun run test:integration

# Unit + integration + script tests
bun run test:all

# With coverage
bun run test:coverage
```

## Environment Variables

Most tests need no env vars — `TestHarness` provides full isolation via `SONAR_CLI_KEYCHAIN_FILE`.

The exception is `analyze-secrets` tests that validate authenticated secret scanning.
Those tests pass `SONAR_SECRETS_AUTH_URL` and `SONAR_SECRETS_TOKEN` to the
`sonar-secrets` binary. If the variables are absent the tests still run but
authenticated scan scenarios will behave as unauthenticated.

## Architecture

### TestHarness

All tests under `specs/` use `TestHarness` — a builder that:

- creates an isolated `tmpdir` per test
- writes `state.json` with the requested connection/auth setup
- writes a file-based `keychain.json` instead of touching the system keychain
- spawns `dist/sonarqube-cli` with a clean environment (only `PATH`, `HOME`, etc.)
- stops any fake HTTP servers and deletes `tmpdir` on `dispose()`

```typescript
const harness = await TestHarness.create();

harness
  .env()
  .withActiveConnection('https://sonarcloud.io', 'cloud')
  .withKeychainToken('https://sonarcloud.io', 'my-token', 'my-org')
  .withSecretsBinaryInstalled();

const result = await harness.run('analyze secrets --stdin', { stdin: 'content' });
await harness.dispose();
```

### FakeSonarQubeServer

Tests that call SonarQube APIs use `FakeSonarQubeServer` — an in-process HTTP server
that records requests and returns configured responses:

```typescript
const server = await harness.newFakeServer().withProject('my-project-key').start();

// server.url → 'http://127.0.0.1:<port>'
// server.requests → recorded HTTP calls
```

## Test Structure

```
tests/integration/
├── README.md
├── harness/
│   ├── index.ts                  # TestHarness — main entry point
│   ├── cli-runner.ts             # Spawns dist/sonarqube-cli
│   ├── environment-builder.ts    # Builds state.json + keychain.json
│   ├── fake-sonarqube-server.ts  # In-process HTTP stub
│   ├── fs-builder.ts             # Filesystem helpers for test projects
│   └── types.ts                  # Shared types (CliResult, RunOptions…)
├── resources/
│   └── sonar-secrets             # Real binary, gitignored — see Prerequisites
├── specs/                        # TestHarness-based tests (require binary)
│   ├── analyze-secrets.test.ts
│   ├── auth.test.ts
│   ├── install-secrets.test.ts
│   ├── integrate.test.ts
│   ├── list-issues.test.ts
│   ├── list-issues-auth.test.ts
│   ├── list-projects.test.ts
│   └── secret-scan.test.ts
└── secret-install-integration.test.ts  # Imports TypeScript directly (no binary needed)
```

## Troubleshooting

### Tests fail instantly (0–5 ms) with binary-not-found error

The binary is missing or stale. Run `bun run build:binary`.

### `sonar-secrets mock binary not found` error

`tests/integration/resources/sonar-secrets` is missing.
Follow the [Install the sonar-secrets binary](#2-install-the-sonar-secrets-binary) step above.

### Tests time out on secret scanning

The `sonar-secrets` binary contacted a real endpoint and didn't get a response.
Check that `SONAR_SECRETS_AUTH_URL` points to a reachable server, or run tests
without authentication env vars to use the unauthenticated path.
