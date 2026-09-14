# About this project

A CLI tool (`sonar`) that integrates SonarQube Server and Cloud into developer workflows.

Release builds publish standalone executables for `linux-x86-64`, `linux-arm64`, `macos-arm64`, and `windows-x86-64`. binaries.sonarsource.com artifacts use the `.bin` suffix on Linux/macOS and `.exe` on Windows (e.g. `sonarqube-cli-{version}-linux-x86-64.bin`); versions published before that convention remain `.exe` on the CDN. Dependency binaries (sonar-secrets, sca-scanner-cli) still use `.exe` in download URLs. The stable installers (`user-scripts/install.sh`, `user-scripts/install.ps1`) resolve the real release version from `Distribution/sonarqube-cli/stable.version`; the shell installers select the Linux artifact using `uname -m` (`aarch64` / `arm64` → `linux-arm64`, `x86_64` / `amd64` → `linux-x86-64`) and try `.bin` then `.exe` when downloading. They also keep a literal compatibility version marker for older `sonar self-update` clients, and `full-release.yml` updates that marker to the latest released version during the post-release bump PR.
Compiled binaries are produced via `build-scripts/build-binary.ts`, which injects `SONARQUBE_CLI_DISTRIBUTION` at compile time. The only supported value is `standalone`, and standalone-only flows such as `self-update` key off that distribution marker.

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
- **MANDATORY**: After editing any `.ts` file, run `bun run format` (or `bun x prettier --write <file>`), then `bun run lint:fix` (or `bun x eslint --fix <file>`) so ESLint autofix applies `simple-import-sort/imports` and other safe fixes.
- Comments are exceptional, not default: name things well instead; a comment must earn its place by saying a one-line "why" that naming can't.

Each command lives in `src/commands/`. The command tree is built by `createCommandTree()` in `src/commands/command-tree.ts` and the entry point is `src/index.ts`.

## Where the detail lives

The rest of this documentation loads on demand, never at session start. Content whose scope is a directory is a nested `CLAUDE.md`, pulled in when Claude reads a file in that directory. Content whose callers do not line up with a directory is a `.claude/rules/` file with a `paths:` list, pulled in when Claude reads a file that list matches.

- `src/commands/CLAUDE.md` — command framework (lifecycle stages, telemetry recording, root help) and per-command notes.
- `src/commands/integrate/CLAUDE.md` — agent secrets hooks and Vortex (SQAA + Context Augmentation) across Claude, Codex, Cursor, Copilot and Antigravity.
- `src/core/framework/CLAUDE.md` — the declarative integration engine behind `sonar integrate`.
- `src/core/telemetry/CLAUDE.md` — events, egress, identity resolution, `project_uuid`.
- `src/core/update/CLAUDE.md` — the self-update lifecycle and its migrations.
- `tests/CLAUDE.md` — test philosophy, harness usage, coverage.
- `.claude/rules/state-and-auth.md` — `state.json`, the keychain, auth resolution, project discovery (`discoverProject()`). Its callers are `src/core/state/`, `src/core/auth/`, four top-level `src/core/` modules, four under `src/core/host/` (the keychain, the lookup-path and recorded-feature resolvers, the caller-agent detector) and the `auth` / `link` commands.
- `.claude/rules/sonarqube-api.md` — the SonarQube API client layer. Clients live both in `src/core/server/` and next to the commands that own them. The repo-wide rule about never calling `fetch` directly stays in this root file, under "Network access", since it binds any code issuing an HTTP request.

`AGENTS.md` is a symlink to this root file, so Codex, Cursor and Copilot get this content but neither on-demand mechanism — open the file above directly when a task touches its area.

## Network access

Every HTTP request the CLI issues itself must carry the proxy/TLS configuration resolved by `src/core/host/connectivity/network-config.ts`, so `src/core/server/fetch.ts` is the only module allowed to call the runtime `fetch` — an ESLint `no-restricted-syntax` rule (scoped to `src/**`, disabled in that one file) rejects `fetch(...)` and `<obj>.fetch(...)` anywhere else. It exports two wrappers, both of which resolve `buildFetchNetworkOptions(url)` themselves:

- `fetchAuthenticated(url, init)` — for a request whose headers carry a credential. Applies the network configuration **and** blocks credential leaks through cross-origin redirects (`redirect: 'manual'`, same-origin and HTTP→HTTPS-upgrade hops only). Use it for anything sending a credential header.
- `fetchAnonymous(url, init)` — applies the network configuration and lets the runtime follow redirects normally. Only for credential-free requests that need to follow a CDN redirect: `downloadBinary` (`core/host/install/sonarsource-releases.ts`), the `stable.version` check (`core/update/check.ts`), and `fetchServerVersion` (`core/server/server-info.ts`). It **throws** when `init.headers` carries `authorization`, `cookie`, `private-token`, or `x-api-key`, since the runtime would follow a cross-origin redirect with that header attached — the ESLint rule cannot tell the two wrappers apart, so this invariant is enforced at runtime instead.

Call sites never pass proxy/TLS options: `buildRequest(method, headers, timeoutMs, body)` deliberately cannot carry them, and both wrappers drop any `proxy`/`tls` keys found on `init` before spreading the resolved ones, so the configuration cannot be overridden locally. `fetchAuthenticated` resolves options **per hop**, so a followed HTTP→HTTPS upgrade never reuses the options computed for the original scheme. An unusable configuration surfaces as `NetworkConfigError` rather than a silent direct connection — `flushTelemetryEvents` aborts the batch on it and requeues every event instead of retrying per event.

Known gap: **Sentry** (`src/core/observability/sentry.ts`) transmits through the SDK's own transport, which never sees the `SONAR_*` proxy/CA settings, and the ESLint rule cannot reach into `node_modules`. Behind a mandatory corporate proxy, crash reports do not leave the machine. Anything else that reports outward through a third-party SDK inherits the same gap.

## Error handling

Please use the exception types defined in `src/core/commands/command-error.ts` for production code. If you need to throw an error from a mock in test code, it's fine to use the generic `Error` type.

Error subclasses extend the abstract `CliError` and carry their own `exitCode`, which `SonarCommand.runCommand()` forwards to `process.exitCode`:

- `InvalidOptionError` → exit code `2` (conflicting or invalid CLI options).
- `CommandFailedError` → exit code `1` by default, or whatever is passed to the constructor.
- Any other `Error` caught by `runCommand` → exit code `1`.

`CliError` also supports an optional `remediationHint`. When present, `SonarCommand.runCommand()` prints the error message first, then renders the hint on a separate `💡` line.

## Documentation

When adding, removing, or changing commands, scripts, or project structure, update `CLAUDE.md`, and `AGENTS.md` to reflect the change before finishing. When the change belongs to one of the areas listed under "Where the detail lives", update that file instead of growing this root file back out.

## Docs site (`docs/`)

The docs site is generated from the CLI source — do not edit `commands.json`, `llms.txt`, or `sitemap.xml` by hand. This is done by automation post-release. The docs generator also stamps the current package version into the nav badge in `index.html` and `commands.html`, plus the JSON-LD `softwareVersion` and `meta-version` in `index.html`.
Keep a fixed `<base href="/sonarqube/cli/">` in the docs HTML so production resolves relative assets and internal links under the public mount point. This is intentionally production-oriented: Netlify deploy previews served from `/` will not work with that fixed base.

<!-- sonar:begin:sonarqube-agentic-analysis-protocol -->

# Vortex analysis protocol

Vortex analysis is the final confirmation layer at the end of every turn in which you wrote to one or more files in the workspace (create, edit, patch, format — any tool call that changed file contents on disk).

**Trigger:** the moment before you send your final reply for the turn.

When the trigger fires, you **MUST** run Vortex analysis on the full set of files you modified this turn — **one command, not a per-file loop**.

**Preferred:** pass every path you modified this turn in a single invocation (repeat `--file` for each path). Use paths **relative to the project root** (e.g. `src/foo.ts`). For end-of-turn analysis, **always** pass `--depth DEEP` — even when you changed only one file — so cross-file findings are included.

```bash
sonar analyze agentic --depth DEEP --file <path/to/file1> --file <path/to/file2>
```

**Fallback:** when you cannot reliably list every modified path (e.g. you did not track them, or git state is the only source of truth), use the git change set with DEEP analysis:

```bash
sonar analyze agentic --depth DEEP
```

Per-edit hooks run faster STANDARD analysis. End-of-turn analysis must always use `--depth DEEP` (including a single `--file`). Use `--depth STANDARD` only for optional faster passes — never for the mandatory end-of-turn run.

Non-negotiable rules:

1. Mid-turn edits do **not** need Vortex analysis — only the final on-disk state matters. Skipping Vortex analysis at end-of-turn is a protocol violation.
2. Run Vortex analysis **before** sending your final reply, marking the task done, or handing control back to the user.
3. If Vortex analysis reports issues on lines you touched in this turn, fix them, then re-run Vortex analysis on the same scope (change set or explicit file list). Repeat until clean (or only pre-existing findings on lines you did not touch remain). Pre-existing findings on untouched lines are out of scope — do not "fix" them unless the user asked.
4. If Vortex analysis is skipped (no SonarQube Cloud connection, or no project configured), state the skip reason to the user once and continue — do not retry.
5. Do not suppress, summarize away, or omit Vortex analysis findings from your reply. Surface them verbatim.

<!-- sonar:end:sonarqube-agentic-analysis-protocol -->
