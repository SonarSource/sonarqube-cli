# About this project

A CLI tool (`sonar`) that integrates SonarQube Server and Cloud into developer workflows.

Release builds publish standalone executables for `linux-x86-64`, `linux-arm64`, `macos-arm64`, and `windows-x86-64`. binaries.sonarsource.com artifacts use the `.bin` suffix on Linux/macOS and `.exe` on Windows (e.g. `sonarqube-cli-{version}-linux-x86-64.bin`); versions published before that convention remain `.exe` on the CDN. Dependency binaries (sonar-secrets, sca-scanner-cli) still use `.exe` in download URLs. The `user-scripts/install.sh` and `user-scripts/install-prerelease.sh` installers select the Linux artifact using `uname -m` (`aarch64` / `arm64` → `linux-arm64`, `x86_64` / `amd64` → `linux-x86-64`) and try `.bin` then `.exe` when downloading.

# Running checks

Use the package.json scripts for full test runs.

```bash
bun run lint              # ESLint (TypeScript-aware, includes import sort)
bun run lint:fix          # Auto-fix safe issues
bun run typecheck         # tsc --noEmit
bun run test:unit         # All unit tests
bun run test:integration  # All integration tests, no coverage (local development)
bun run test:all          # Unit + integration
bun run test:e2e          # end-to-end tests
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

Declarative integration registry helpers live in `src/cli/commands/integrate/_common/registry/index.ts`. New integration descriptors should use that public entrypoint for dependency/resource factories, operations, and registry validation. Command handlers should keep command-specific validation, prompts, and target resolution thin, then delegate feature selection, generic install messages, dependency/resource application, and state recording to `src/cli/commands/integrate/_common/installer.ts`.

### Context Augmentation

`sonar context [action] [args...]` is a passthrough to the locally-installed `sonar-context-augmentation` binary (CAG). It forwards args verbatim, propagates the child exit code, and injects context through `SONAR_CONTEXT_ORGANIZATION`, `SONAR_CONTEXT_PROJECT`, `SONAR_CONTEXT_TOKEN`, and `SONAR_CONTEXT_URL` env vars. Every CAG spawn (including the `--help` path and the integrate/post-update flows) also carries `SONAR_CONTEXT_INVOCATION_ID` — the per-CLI-process correlation id from `src/lib/invocation-id.ts`, shared with telemetry's `invocation_id` and forwarded by CAG to its daemon as the `x-sonar-invocation-id` header. The passthrough resolves project context from the recorded declarative CAG feature state for the current project rather than running full project auto-discovery. Implementation in `src/cli/commands/context/`. The binary is downloaded by `sonar integrate claude` / `sonar integrate copilot` / `sonar integrate codex` (skip with `--skip-context`); `sonar context` itself never auto-installs and emits a clear "not installed" error pointing the user back to integrate. `--global` integrations also skip CAG setup; install it by re-running `sonar integrate <agent>` from a project directory. The `--global` skip notice (`Skipping Context Augmentation: not supported with --global. Re-run without --global from a project directory to install it there.`) is only emitted when the org is actually entitled to CAG — unentitled orgs skip silently. The CLI owns the agent skill file declaratively as a `wholeFile` resource inside a single CAG feature and renders it by calling `sonar-context-augmentation tool print-skill --invocation-prefix "sonar context" --sca-enabled=<resolved>`; the rendered file is written to `.claude/skills/sonar-context-augmentation/SKILL.md`, `.github/skills/sonar-context-augmentation/SKILL.md`, or `.agents/skills/sonar-context-augmentation/SKILL.md` depending on the agent. That same feature also declares a `tool integrate --invocation-prefix "sonar context"` operation, but the operation is install-only: the framework passes `executionMode=install|update` into feature contexts, and CAG uses `shouldApply` so `tool integrate` runs during `sonar integrate <agent>` but not during post-update refreshes. Post-update still reinstalls the shared dependency, best-effort runs `sonar-context-augmentation tool stop --all` against the previously-installed binary before replacing it, and refreshes the skill file. Replay failures are debug-logged so they do not abort CLI startup.

`--help`, `-h`, and bare `sonar context` (no action) are forwarded to CAG.

Before installing, `sonar integrate claude|copilot|codex` pre-flights the CAG entitlement check: `SonarQubeClient.hasCagEntitlement(orgKey)` resolves the org UUID via `/organizations/organizations` then calls `GET /a3s-analysis/cag-org-config/{uuid}` (SonarQube Cloud only). If `eligible && enabled` is false, CAG setup is skipped with a warning (cloud) or a plain info line (SonarQube Server). Any error in the check is treated as "not entitled". The `sonar context` passthrough is not gated — CAG itself enforces entitlement per-request.

After the CAG entitlement check passes, the integrate flow also queries SCA availability via `SonarQubeClient.getScaEnablement(connectionType, orgKey)` (`/sca/feature-enabled` on cloud, `/api/v2/sca/feature-enabled` on SonarQube Server). The resolved boolean is passed to `sonar-context-augmentation tool print-skill` as `--sca-enabled=true|false`, and is persisted on declarative feature attrs together with the recorded `serverUrl`, `orgKey`, and `projectKey` so `sonar context` and post-update can reuse the same connection metadata without re-querying the server. A check failure (network/404) emits a warn line and proceeds with `--sca-enabled=false`.

The CAG installer (`src/cli/commands/_common/install/context-augmentation.ts`) handles `.tar.gz` archives: download → verify detached `.asc` PGP signature → gunzip + USTAR-extract the inner binary into `~/.sonar/sonarqube-cli/bin/`. Tar reading is in `src/cli/commands/_common/install/tar.ts` (no external dep). The pinned CAG version is in `package.json#externalBinaries["sonar-context-augmentation"]` and `src/lib/signatures.ts`. In the declarative framework, the CAG binary is managed as a shared dependency (`sonar-context-augmentation`), while a single declarative feature owns both the skill file resource and the install-only `tool integrate` operation with the invocation prefix forced to `sonar context`.

### System reset

`sonar system reset` returns the CLI to a factory-like state in one shot. Registered as `anonymousAction` so it works when auth is broken. Implementation is split across `src/cli/commands/system/reset.ts` (orchestration), `reset-auth.ts`, `reset-binaries.ts`, `reset-integrations.ts`, `reset-filesystem.ts`, and `safe-path.ts`.

## Error handling

Please use the exception types defined in `src/cli/commands/_common/error.ts` for production code. If you need to throw an error from a mock in test code, it's fine to use the generic `Error` type.

Error subclasses extend the abstract `CliError` and carry their own `exitCode`, which `SonarCommand.runCommand()` forwards to `process.exitCode`:

- `InvalidOptionError` → exit code `2` (conflicting or invalid CLI options).
- `CommandFailedError` → exit code `1` by default, or whatever is passed to the constructor.
- Any other `Error` caught by `runCommand` → exit code `1`.

`CliError` also supports an optional `remediationHint`. When present, `SonarCommand.runCommand()` prints the error message first, then renders the hint on a separate `💡` line.

## State and auth

- Persistent state (server URL, org, project) is managed via `src/lib/state-manager.ts`.
- Declarative integration installs are tracked as integration entries in the top-level `integrations.installed` state registry, with installed feature targets nested under each integration. Shared declarative dependencies (for example SonarSource binaries required by multiple features) are recorded separately in `dependencies.installed` and referenced from features by id. This is the generic state surface for Git, Claude, Codex, Copilot, and future integrations; legacy `agents` and `agentExtensions` remain for compatibility.
- Tokens are stored in the system keychain via `src/lib/keychain.ts` — never store tokens in plain files.
- All path and URL constants live in `src/lib/config-constants.ts` — import from there instead of hardcoding.
- Caller-agent hints (Cursor, Claude Code, or Copilot CLI) from the environment: `src/lib/agent-detector.ts` (`detectCallerAgent`, etc.).
- `sonar auth logout` relies on state: if there is no active connection or `isAuthenticated` is false, it only reports that you are already logged out (no keychain changes).
- When `sonar auth login` runs the browser-based OAuth flow, the server-generated token name returned in the callback POST body is captured and persisted on the connection as `tokenName` (see `AuthConnection` in `src/lib/state.ts`). The wire field is `name` (matching `/api/user_tokens/revoke?name=`); we keep it as `tokenName` in-memory to disambiguate from other "name" fields.
- On `sonar auth logout`, the CLI best-effort revokes the server-side token via `SonarQubeClient.revokeUserToken(...)` (a one-line wrapper over the generic `postForm(endpoint, params)` helper) before clearing the keychain entry. Failures (network error, non-2xx response) are reported via a warning on stderr; local cleanup still proceeds. When the connection has no `tokenName` (e.g. upgraded from an older CLI version), the CLI emits a manual-revocation hint on stderr instead.

## Tests

### Philosophy

**Integration tests are the default.** Unit tests are justified only when a situation is genuinely hard to recreate via integration tests due to test setup complexity. Before writing a unit test, first consider extending the harness or fake server infrastructure to handle the scenario. Unit tests are a last resort.

Follow the structure of existing tests for the command or feature area you are working in.

- Unit tests: `tests/unit/` — use `src/ui/mock.ts` for UI layer, `tests/unit/keychain/keychain-test-handle.ts` for keychain.
- Integration tests: `tests/integration/specs/<command>/` — run the compiled binary against fake servers. Use `TestHarness` from `tests/integration/harness/`.
- E2E tests: `tests/e2e/` — real external dependencies that cannot be faked: OS keychain, install scripts with real network, real SonarQube server calls, and integration with external tools. Those tests are black-box tests and exercise the product from the outside. `tests/e2e/context/` is the offline real-binary suite for `sonar-context-augmentation`: it seeds CAG state in `state.json`, lets `runPostUpdateActions()` re-download CAG from `binaries.sonarsource.com`, and covers post-update refresh (`cag-offline.test.ts`), edge cases like missing project roots / global skills / multi-skill refresh / stale-binary cleanup (`cag-edge-cases.test.ts`), passthrough behaviors including unauthenticated errors and exit-code propagation (`cag-passthrough.test.ts`), the `copilot-cli` skill path (`cag-copilot.test.ts`), the `codex` skill path (`cag-codex.test.ts`), and `sonar integrate` pre-flight skip paths against a fake server — SonarQube Server connections and disabled entitlement (`cag-integrate.test.ts`; the happy path is deferred because CAG's daemon socket path exceeds the AF_UNIX limit under the harness `tmpdir` layout). Shared scaffolding lives in `_helpers.ts`. No SonarQube/Cloud access required — only the binaries CDN.

Before writing a test, find an existing spec for the same command area and follow its structure.

### Integration test harness

Each test creates a fresh `TestHarness` and disposes it in `afterEach`. The harness runs the compiled binary in a fully isolated environment (temp dir, fake keychain, fake servers). For fine-grained state setup beyond `withAuth`, use `harness.state()` builder (see `tests/integration/harness/environment-builder.ts`). For git hook tests, use `initGitRepo` / `stageFile` from `tests/integration/specs/hook/git-test-helpers.ts`.

### Coverage

To run tests with coverage and produce the LCOV reports consumed by SonarQube, use:

```bash
bun run test:coverage        # full pipeline: unit + integration + merge
bun run test:coverage:unit   # unit only (faster, no binary build needed)
```

Do **not** use `bun test --coverage` directly — Bun's native LCOV reporter emits spurious entries on non-executable lines (signatures, braces, blank lines) that cause false positives in SonarQube.

## Documentation

When adding, removing, or changing commands, scripts, or project structure, update `CLAUDE.md`, and `AGENTS.md` to reflect the change before finishing.

## Docs site (`docs/`)

The docs site is generated from the CLI source — do not edit `commands.json`, `llms.txt`, or `sitemap.xml` by hand. This is done by automation post-release.
