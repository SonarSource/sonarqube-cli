# About this project

A CLI tool (`sonar`) that integrates SonarQube Server and Cloud into developer workflows.

Release builds publish standalone executables for `linux-x86-64`, `linux-arm64`, `macos-arm64`, and `windows-x86-64`, built by `build-scripts/build-binary.ts` (which injects the `SONARQUBE_CLI_DISTRIBUTION` marker; the only supported value is `standalone`). CDN artifacts use `.bin` on Linux/macOS and `.exe` on Windows; older releases and dependency binaries (sonar-secrets, sca-scanner-cli) remain `.exe`. The installers (`user-scripts/install.sh`, `install.ps1`) resolve the release version from `Distribution/sonarqube-cli/stable.version`, and try `.bin` then `.exe` when downloading. Both also carry a **literal, unused version marker** (`version="..."` / `$SonarVersion = "..."`) that older `sonar self-update` clients scrape out of the file — do not delete it as dead code; `full-release.yml` rewrites it during the post-release bump PR.

# Running checks

```bash
bun run lint              # ESLint (TypeScript-aware, includes import sort)
bun run lint:fix          # Auto-fix safe issues
bun run typecheck         # tsc --noEmit
bun run test:unit         # All unit tests
bun run test:integration  # All integration tests
bun run test:all          # Unit + integration
bun run test:e2e          # End-to-end tests
```

Single test file — **unit**: `bun test <file>`. **Integration**: run `bun run pretest:integration` once first (builds binary, sets up resources), then `bun test <file>`.

# Writing code

- Always fix TypeScript errors before considering a task done.
- Never attempt to fix linting issues until the implementation is correct.
- Use `import type` for type-only imports.
- **MANDATORY**: after editing any `.ts` file, run `bun run format` then `bun run lint:fix`.
- Comments are exceptional, not default: name things well instead; a comment must earn its place by saying a one-line "why" that naming can't.

## Commands

Each command lives in `src/commands/`; the tree is built by `createCommandTree()` in `src/commands/command-tree.ts`, entry point `src/index.ts`. Declare commands with the type in `src/commands/sonar-command.ts`.

- Register `authenticatedAction()` by default (handler receives a `CommandAuthenticatedInvocationContext`); `anonymousAction()` is only for technical commands. Both contexts live in `src/commands/command-invocation-context.ts`.
- Handlers record telemetry with `ctx.recordTelemetry(new TelemetryFact(name, payload))`, where `payload` is bare domain data. `postAction` commits those facts plus a `CliCommandExecuted` fact and schedules the flush.
- Lifecycle: `.stage(Stage.Stable)` (default), `.stage(Stage.Alpha)`, `.stage(Stage.Beta())` (Open Beta), `.stage(Stage.Beta('cli.beta.flag-key'))` (Private Beta, gated by LaunchDarkly). Alpha needs `SONARQUBE_CLI_ALPHA`. `createCommandTree` is async and only contacts LaunchDarkly when Private Beta flag keys exist. On the context, `isAlphaEligible()` / `isBetaEligible()` answer whether *this execution* is entitled; `isAlpha` / `isBeta` are stage-name checks used for help visibility. Only Open Beta appears in public docs.
- Options are staged via `addOption(new SonarOption('--flag', 'Help').stage(...))` — `.option()` returns the command, so it can't be staged. Required options cannot be staged. Unentitled options are omitted from help and treated as unknown.
- Visible top-level commands should declare `rootHelp({ category })` (`core`, `data`, `integrate`, `cli-management`) for the custom root menu; display order follows declaration order in `command-tree.ts`. Use `rootHelp({ expandSubcommands: true })` or `rootHelp({ label })` only when the derived `name <sub1|sub2>` label isn't enough. Hide a command with Commander `{ hidden: true }`.

### Notable commands

- `sonar analyze` accepts `-p, --project` for the agentic portion; `--branch` is specific to `analyze agentic` / `verify` and is auto-detected from git when omitted. `--depth STANDARD|DEEP`: change-set and multi `--file` default to DEEP, single `--file` to STANDARD. Per-edit hooks force STANDARD; end-of-turn instructions always pass DEEP.
- `sonar analyze dependency-risks` auto-detects the project via `discoverProject()` when `-p` is omitted, and pre-scans manifest files for secrets before the SCA scan. In the `analyze` path the secrets binary is a hard prerequisite; in the git pre-commit path a *scan error* fails open. Distinct from the secrets-hook gate: unauthenticated or missing binary blocks the commit (`MissingDependenciesError` → exit 1).
- `sonar quality-gate status` shows the project quality gate verdict (`GET /api/qualitygates/project_status`, identical on Cloud and Server).
- `sonar import` (hidden, in development) provisions a bound project from a connected DevOps platform. Uses the connection's org, requires org admin, and supports only GitHub/Azure DevOps. Exactly one of `--repo`, `--all`, `--regex` (matched against the platform *name*, accepts a `/pattern/flags` literal); omitting all three prompts interactively, `--non-interactive` requires one.
- `sonar system reset` returns the CLI to a factory-like state; registered as `anonymousAction` so it works when auth is broken. Removes declarative features and binaries, clears legacy state and `knownServerProjectMappings`. Partial reset exits `0`.
- `sonar system status` is a diagnostic overview (auth verified live, binaries, integrations, MCP status, `--json`). Shows a VORTEX section when Vortex is applicable. Only genuine entitlement loss (`not_entitled`) makes it unhealthy; quota exhaustion and check failures stay healthy.

## Declarative integration framework

The engine lives under `src/core/framework/` (`features/`, `resources/`, `dependencies/`) with no CLI coupling. Integration descriptors import from `@/core/framework/features`. Command handlers keep validation, prompts, and target resolution thin, then delegate to `install-integration.ts` for selection, install messages, dependency/resource application, and state recording.

- **Container + subfeatures**: a `FeatureContainer` owns a centralized resource and declares `subfeatures`, each with its own dependencies/resources/operations but inheriting scope, target root, and attrs. Ids must be unique across the container and all subfeatures. Read a feature's full asset set with `recordedFeatureResources` / `recordedFeatureOperations`, not `feature.resources`. Removing a container removes subfeature assets too; a subfeature that stops being active has its resources removed and undoable operations reversed.
- Resource removers delete an emptied file rather than leaving a husk (`text-snippet` when only whitespace remains; patch removers when the document prunes to its `defaultValue`). Other content survives pruning; empty dirs are left in place.
- Framework install must not import telemetry events — it takes an `onSuccess` facts callback and the command records telemetry.

## Integrations

Bare `sonar integrate` prompts for one integration (Claude, Copilot, Codex, Cursor, Antigravity, Git) and delegates. All subcommands share `--project` / `--global` scope flags and resolve scope via `resolveIntegrateScope()`: interactive sessions prompt after the preflight summary, `--non-interactive` defaults to project, an explicit project key implies project scope.

### Git

`sonar integrate git` accepts `--dependency-risks` + `-p <project>` to add a pre-commit SCA scan alongside the mandatory secrets scan. `--dependency-risks` requires `-p` (`-p` alone is fine — it just leaves SCA to the interactive prompt), and neither flag is valid with `--global`. The `pre-commit-hook` container owns the hook resource (attr-driven, re-renders when attrs change) with `pre-commit-secrets` (mandatory) and `pre-commit-dependency-risks` (optional) subfeatures. SCA is pre-commit and project-scope only, supported by all three git strategies (native, husky, pre-commit framework). At runtime `sonar hook git-pre-commit` falls back to `discoverProject()` when `--dependency-risks` is set without `-p`; a secrets-only hook is project-agnostic and never discovers. A global native hook chains to a pre-existing local hook so `core.hooksPath` doesn't silently disable it.

### Agent secrets hooks

`sonar integrate codex` installs a prompt-submit secrets hook; `claude` installs that plus a `PreToolUse` (`Read`) file-read hook; `cursor` installs a prompt hook plus two file-read hooks. Each is a generated shell/PowerShell script that calls a `sonar hook <agent>-<event>` handler (`src/commands/hook/`), scans stdin with `sonar-secrets`, and blocks on a hit. They **fail closed**: `resolveAuthAndSecrets()` throws `MissingDependenciesError` when unauthenticated or the binary is missing.

Output contracts differ per agent: Claude/Codex emit `{ "decision": "block", "reason": ... }`; Cursor's prompt hook emits `{ "continue": false, "user_message": ... }` and exits 0; Cursor's file-read hooks emit `{ "permission": "deny", ... }` and **exit 2** (only exit 2 is a deny — other non-zero codes fail open), and append the file to `.cursorignore`.

Claude and Codex use the shared `createSonarSecretsHooksFeature` factory with the nested `{ hooks: { <event>: [{ matcher, hooks: [...] }] } }` shape. Cursor declares its hooks inline and writes a flat, typed schema to `.cursor/hooks.json`. Matchers are pinned per event (`beforeReadFile`: `Read|TabRead`, `preToolUse`: `Read`, `beforeSubmitPrompt`: `UserPromptSubmit`) because an invalid matcher like `*` silently disables the hook; the two Cursor read hooks overlapping on `Read` is deliberate defense-in-depth.

Hook `command` strings are built by `resolveAgentHookCommand` / `createAgentHookEntry`. **For Claude only**, project-scope paths are anchored to `CLAUDE_PROJECT_DIR_PLACEHOLDER` so hooks keep resolving when Claude Code's cwd diverges from the project root. That placeholder path must be **double**-quoted on both Windows and Unix — it does not expand inside single quotes, which makes the hook silently fail. `resolveAgentHookCommand` picks the quoting itself.

### Vortex

**Vortex** is the umbrella for SQAA (agentic analysis) and Context Augmentation (CAG), delivered as one `vortex` container feature (`integrate/_common/vortex.ts`). Subfeature ids match the ids these capabilities had standalone, so `replacedIds` migrates older installs on post-update. One prompt installs everything; a missing or unlicensed hub installs none of it. `resolveVortexSetup()` runs the single entitlement check, resolves the SCA flag, and owns the promotion / `--global` skip messaging.

**Naming**: `SQAA` is internal only (file names, symbols, feature ids). Every user-facing string says **"Vortex analysis"**. Prefer Vortex naming in new code.

**Entitlement**: `integrate claude|copilot|cursor|codex|antigravity` pre-flights a Vortex check. Cloud vs Server follows the connection URL, and both hubs (A3S and CAG) are queried either way; Server sends the nil UUID as an organization placeholder since omitting it 404s. A Server 404 from either hub means `not_applicable` (hub absent from that edition); a Cloud 404 stays `check_failed`. `mergeVortexEntitlement` AND-merges: `not_applicable` wins, otherwise `check_failed > not_entitled > over_consumption > enabled`. Install happens on `enabled` or `over_consumption`; `not_entitled` / `not_applicable` remove previously installed Vortex features; `check_failed` preserves them. Consumption never blocks install — only runtime tool calls. `src/core/vortex/entitlement.ts` is the single entry point callers should use (`resolveVortexEntitlement`, `recheckVortexEntitlement`); the hub requests, the 404 mapping, and `mergeVortexEntitlement` live in `src/core/server/client.ts`.

After entitlement, integrate queries SCA availability and passes it to `print-skill` as `--sca-enabled`; the boolean plus `serverUrl`, `orgKey`, `projectKey` are persisted on feature attrs so `sonar context` and post-update need not re-query. A check failure warns and proceeds with `false`.

**SQAA delivery** is per agent. The `--project <key>` baked into a generated script is the fast path; handlers fall back to `discoverProject()` when it's absent.

- **Claude Code** (project scope, when entitled): a `PostToolUse` hook on `Edit|Write` runs immediate single-file STANDARD analysis, reporting via `hookSpecificOutput.additionalContext` and never blocking; plus end-of-turn DEEP instructions in `CLAUDE.md`.
- **Codex**: `PostToolUse` on `apply_patch` for change-set STANDARD analysis, plus end-of-turn instructions in `AGENTS.md`.
- **Copilot, Cursor, Antigravity**: instructions/rules only — Cursor's `afterFileEdit` hook is fire-and-forget and cannot return context. Copilot writes `.github/instructions/sonarqube.instructions.md`; Cursor writes `.cursor/rules/sonar-agentic-analysis.mdc` (`alwaysApply: true`); Antigravity writes `.agents/rules/sonar-agentic-analysis.md` (`trigger: always_on`).

**Teardown** depends on file ownership: Claude/Copilot/Codex write a `textSnippet` fenced by `sonar:begin:` / `sonar:end:sonarqube-agentic-analysis-protocol` markers into a shared file, so removal deletes only the fenced region. Cursor and Antigravity own a dedicated rule file declared `wholeFile` with **no** `managedMarker`, so teardown deletes it even if the content drifted. Never key teardown on the section heading text — it is not a marker and has been renamed.

### Context Augmentation

`sonar context [action] [args...]` is a passthrough to the locally-installed `sonar-context-augmentation` binary. It forwards args verbatim, propagates the exit code, and injects `SONAR_CONTEXT_ORGANIZATION` / `_PROJECT` / `_TOKEN` / `_URL` / `_INVOCATION_ID` (the correlation id shared with telemetry). Project context comes from `discoverProject()`, and `SONAR_CONTEXT_WORKSPACE_ROOT` is set to `discovered.projectRoot` (unset, and any inherited value dropped, when nothing resolves). `--help` and a bare invocation are forwarded to CAG.

The binary is installed by the agent integrations; `sonar context` never auto-installs and errors with a pointer back to integrate. `--global` skips CAG (the skip notice is only shown when the org is actually entitled). Tests bypass CAG setup with `__SQCLI_DEV_SKIP_CAG=1`.

The CLI owns the agent skill file as a `wholeFile` resource, rendered by `sonar-context-augmentation tool print-skill` (forwarding the recorded org so org-gated tools appear) and written to `.claude/skills/`, `.github/skills/`, or `.agents/skills/`. Cursor also uses `.agents/skills/`, the shared cross-tool directory, rather than a private copy. The same subfeature declares an install-only `tool integrate` operation (gated by `shouldApply` on `executionMode`), so it runs during integrate but not post-update refreshes. Post-update reinstalls the dependency, best-effort stops the old binary, and refreshes the skill; replay failures are debug-logged so startup never aborts.

The installer handles `.tar.gz`: download → verify detached `.asc` PGP signature → gunzip + USTAR-extract into `~/.sonar/sonarqube-cli/bin/`. Tar reading is in `src/core/io/tar.ts`. The pinned version lives in `package.json#externalBinaries` and `src/core/host/install/signatures.ts`.

### Claude hook dispatch containers

Every Claude hook event routes through the `sonar hook <event>` naming convention, but the container/dispatcher machinery is reserved for events with **more than one** Sonar subscriber — a single-subscriber event is just a plain resource. `PostToolUse` is the only multi-subscriber event today (SQAA on `Edit|Write`, CAG on `Bash|PowerShell|Monitor|Read`), so it is the only one wrapped in `createClaudeHookEventContainer`, whose `jsonPatch` computes the matcher as the union of active subfeatures. The container aggregates its subfeature votes: it installs if any subfeature votes install or ask, otherwise uninstalls if any voted uninstall, otherwise skips and preserves the current state.

The dispatcher reads stdin once and runs every matching subscriber, concatenating their `additionalContext` — unless one returns `{ decision: 'handled' }`, which short-circuits the rest and skips the dispatcher's own output. CAG's subscriber always returns `handled` and forwards the raw stdin in-process via `runContextPassthrough(..., { stdinPayload })`, so CAG's richer hook JSON reaches Claude Code byte-for-byte. `PostToolUseFailure` has a single subscriber (CAG) and is a direct forward.

Both CAG hooks gate on `isCagHookOrgAllowed`, mirroring CAG's own internal org allowlist — for every other entitled org the whole subfeature is skipped, avoiding an installed-but-inert hook script.

## Telemetry

Core telemetry is event-agnostic: `emitTelemetryEvent(name, fields)` prefixes `Analytics.Cli.`, merges identity, and appends to `telemetry-events.ndjson`; `flushTelemetryEvents` drains it. Domain payload types live next to producers, not in `src/core`. Identity is applied at drain time from the fact's `auth` when present, else the active connection.

Each analyzer run (sonar-secrets, SQAA, SCA) records exactly one `CliAnalysisCompleted`; its required `details` field carries an analyzer-specific per-rule JSON blob when there are findings and `""` otherwise (never `null` — the null-stripping replacer would drop the column).

**Egress** — two independent inputs. `isTelemetryEnabled(state)` answers *has the user consented*; `resolveTelemetryEgress()` answers *may anything be transmitted*, reading `__SQ_CLI_TELEMETRY_EGRESS` — unset/empty means production and **every other value means `off`**, a deliberately fail-safe fallthrough. It is read in exactly three places: `scheduleTelemetryFlush`, `flushTelemetry` (returns before draining, leaving the queue on disk), and `initSentry`. `flushTelemetryEvents` itself transmits unconditionally so its unit tests can call it with `fetch` mocked. `TELEMETRY_ENDPOINT` / `TELEMETRY_API_KEY` / `SENTRY_DSN` are confined to `telemetry-events.ts` and `sentry.ts` by an ESLint rule.

The two inputs are separate because a single boolean made *collect but do not transmit* inexpressible — the state every telemetry test needs, and the reason fixtures once reached the production backend.

**Test traps** (none caught by lint or CI):

- Spawn the CLI only through the harness or by spreading `ISOLATED_CLI_SPAWN_ENV`; a hand-rolled `Bun.spawn` inherits production egress.
- A unit test that enables telemetry **must** point `SONAR_USER_HOME` at a temp dir. Egress `off` stops *that* process transmitting, but events still land in the developer's real `~/.sonar` queue and their next genuine `sonar` command drains and POSTs them.
- Clearing `__SQ_CLI_TELEMETRY_EGRESS` runs the real spawn/drain paths — mock `Bun.spawn` and `fetch` in the same file.
- Don't pair `withTelemetryEnabled()` with `__SQ_CLI_TELEMETRY_FLUSH__=1`, which no-ops `commitTelemetryFacts` and breaks any spec asserting on `CliCommandExecuted`.

**Identity resolution** (keyed by connection type + server URL + org key + token fingerprint): connection seed → disk cache (`telemetry/identity-cache.json`) → API enrichment of only the missing fields (`/api/users/current`; Cloud also `/organizations/organizations` and `/enterprises/enterprise-organizations`; Server also `/api/system/status`). A fast path skips resolving auth entirely when the active connection is already complete — source-agnostic, since env-var auth keeps connections synced. Telemetry's own `resolveAuth({ silent: true })` suppresses the partial-env-vars warning.

Completeness: **Cloud** requires `user_uuid` and `organization_uuid_v4` (`enterprise_uuid` optional — orgs outside an enterprise still evaluate LaunchDarkly); **Server** requires only `sqs_installation_id` (`user_uuid` is optional on older versions). `user_uuid` is always attempted when unknown; a successful response with no id is cached as confirmed-absent (`null`) so old servers don't re-fetch forever. `enterprise_uuid` is Cloud-only, resolved from the org's legacy id, cached `null` on an empty list, and is **not** added to event payloads. Disk entries are written only on a successful response, so transient failures retry next run; `'field' in entry` distinguishes "not yet tried" from "confirmed absent".

**`project_uuid`** — `string | null`, on `CliCommandExecuted` **only** (other events join on `invocation_id`). Despite the name it is SonarQube's legacy internal `projects.uuid` from `GET /api/navigation/component`, identical on Cloud and Server. `src/core/telemetry/project-uuid.ts` owns the resolver (cache-then-API, never rejects, permanent disk cache keyed by server URL + project key rather than auth fingerprint) and the ambient per-invocation context: `noteProject(auth, projectKey)` records, `currentProjectUuid()` resolves at most once per process. Tests **must** call `resetProjectUuidContextForTests()` in `beforeEach`.

Call `noteProject` wherever a project key resolves and auth is in hand: `resolveSqaaAuthAndProject`, `analyze/dependency-risks.ts`, `remediate/index.ts`, `quality-gate/status/index.ts`, the `hook/` handlers, and `install-integration.ts` (project scope only). `sonar run mcp` deliberately does not — it's long-running, so its `CliCommandExecuted` may never fire.

## Network access

Every HTTP request must carry the proxy/TLS configuration from `src/core/host/connectivity/network-config.ts`, so `src/core/server/fetch.ts` is the **only** module allowed to call the runtime `fetch` — enforced by an ESLint `no-restricted-syntax` rule over `src/**`. Two wrappers, both resolving network options themselves:

- `fetchAuthenticated(url, init)` — for credentialed requests. Blocks credential leaks through cross-origin redirects (`redirect: 'manual'`, same-origin and HTTP→HTTPS upgrades only), resolving options **per hop**.
- `fetchAnonymous(url, init)` — follows redirects normally, for credential-free requests that need a CDN redirect (binary download, `stable.version`, server version). **Throws** when the headers carry a credential, since the ESLint rule cannot tell the wrappers apart.

Call sites never pass proxy/TLS options: both wrappers drop any `proxy`/`tls` keys on `init`. An unusable configuration surfaces as `NetworkConfigError` rather than a silent direct connection — `flushTelemetryEvents` aborts the batch on it and requeues the unsent events rather than retrying per event.

Known gap: **Sentry** transmits through the SDK's own transport, which never sees the `SONAR_*` proxy/CA settings, so behind a mandatory corporate proxy crash reports don't leave the machine. Any third-party SDK reporting outward inherits this.

## Error handling

Use the exception types in `src/core/command-error.ts` for production code (a generic `Error` is fine in test mocks). Subclasses extend `CliError` and carry an `exitCode` that `SonarCommand.runCommand()` forwards to `process.exitCode`:

- `InvalidOptionError` → `2` (conflicting or invalid options)
- `CommandFailedError` → `1` by default, or whatever the constructor is given
- Any other `Error` caught by `runCommand` → `1`

`CliError` supports an optional `remediationHint`, rendered on a separate `  → ` line on stderr after the message.

## State and auth

- Persistent state is managed via `src/core/state/state-manager.ts`. `loadState()` returns defaults only when `state.json` is absent; a corrupt existing file retries then throws, so `saveState()` can't wipe it. Best-effort callers use `tryLoadState()`.
- Declarative installs are tracked under `integrations.installed` (features nested per integration); shared dependencies under `dependencies.installed`, recorded by `recordInstalledDependency()` under the declared pinned version — including installs outside the framework. Legacy `agents` / `agentExtensions` remain for compatibility; legacy `tools.installed` is folded into `dependencies.installed` by `migrateState()`.
- Tokens are stored in the system keychain (`src/core/host/keychain.ts`) — never in plain files.
- Path and URL constants live in `src/core/config-constants.ts` — import from there instead of hardcoding.
- Shared Sonar data lives under `~/.sonar`; CLI-specific data under `~/.sonar/sonarqube-cli`; the anonymous telemetry user id at `~/.sonar/user`. `SONAR_USER_HOME` is a late-bound override for state persistence and the telemetry user id only.
- Caller-agent detection is `src/core/host/environment/agent-detector.ts` — distinct from `installed-agent-detector.ts`, which detects *installed* agents.

### Project discovery

`discoverProject()` (`src/core/project-info.ts`) resolves a project through three sources in turn, each walking the *same* nearest-first lookup-path list so "closer wins" uniformly: (1) known-server-project mappings, (2) `sonar-project.properties` / `.sonarlint`, (3) git-remote binding (a single non-climbed last resort). `resolveLookupPaths(startDir)` (`src/core/host/git/lookup-path-resolver.ts`) builds that list by climbing from the start directory to the repo root and, from a linked worktree, appending the main working tree's offset-equivalent climb — so a mapping recorded in one worktree resolves from any other. Each `LookupPath` carries a `checkPath` (compared) and a `projectRoot` (used on match), so a hit found via the main-tree climb still resolves to the *current* worktree's directory.

`DiscoveredProject.projectRoot` is the directory that matched, defaulting to the invocation directory; `repoRoot` is the git top-level and is **undefined outside a git repository**, so `projectRoot` is the field to read when you need a directory that is always present. They differ routinely in monorepos, and every call site deciding *where on disk to act* — integrate target/scope resolution, the preflight `Root` line, obsolete-artifact cleanup, the MCP filesystem mount, `sonar context`'s workspace dir — reads `projectRoot`.

SQAA and `sonar context` both resolve project keys through this same call rather than reading feature records, so container vs. legacy feature ids are irrelevant to resolution.

### known-server-project mappings

`state.knownServerProjectMappings` (`{ targetRoot, repoRoot?, projectKey, serverUrl?, orgKey? }`) is the persisted half of the discovery fast path. `targetRoot` and `repoRoot` are copied verbatim from a feature's `targetRoot` / `attrs.repoRoot` and never collapsed, so two worktrees integrated with different project keys stay distinguishable. `serverUrl` / `orgKey` are recorded-only, deliberately **not** backfilled from the active connection — that would bake a point-in-time snapshot into a mapping matched much later, possibly under different env-var auth. They matter because `warnAuthProjectMismatches()` reads them to warn when the active connection disagrees with a project's recorded one.

`src/core/known-server-project-mappings.ts` owns `mergeKnownServerProjectMappings` and `buildKnownServerProjectMappings(state)`, both built on `upsertMapping`: two mappings collapse only when they share **both** `targetRoot` and `projectKey`. Same `targetRoot` with a different `projectKey` is a genuine conflict, not a duplicate — both are kept and resolved at match time by `selectFeatureForLookupPaths` (`src/core/host/recorded-feature-resolver.ts`), first-wins rather than most-recent (a feature's `updatedAt` is refreshed on every reconcile pass, so it was never meaningful). A `targetRoot` absent from a fresh pass is never dropped.

There is no explicit write path — project-scoped integrations are being phased out in favor of global scope, so the table is migration-driven. Two things keep it current: the post-update migration (which runs before the declarative one, to capture attrs about to be lost), and a live fallback inside `discoverProject()` for projects integrated since the last upgrade.

### Auth

- **Env-var auth records state exactly like `sonar auth login`, minus the keychain write.** `resolveAuth()` is `resolveFromEnv() ?? resolveFromState()`; the env branch calls `recordConnectionFromAuth()` before returning — the same `addOrUpdateConnection()` + identity enrichment step login uses, just without `saveToken()`, since env-var auth exists for sandboxed environments that can't reach the keychain. It no-ops when the active connection already matches and its identity is complete; `force: true` bypasses that (used by login, which must refresh `authenticatedAt` / `tokenName`).
- `sonar auth logout` reports "already logged out" when `isAuthenticated` is false, there is no active connection, the connection list is empty, or the active connection is `envOnly`. Otherwise it best-effort revokes the server-side token before clearing the keychain; failures warn on stderr and local cleanup proceeds. Without a `tokenName` (older CLI) it prints a manual-revocation hint instead. The token name comes from the OAuth callback body (wire field `name`, kept as `tokenName` in memory).
- **On Cloud, `sonar auth login` validates every organization key it is given.** `--org`, a key from project config, and a hand-typed key are all resolved via `resolveOrganizationAccess()` → `accessible | not_found | check_failed`; keys picked from the membership menu are not re-checked. The three states matter because `/api/organizations/search` answers an unknown key with `200` and an empty list, so an error never means absence. Never validate manual entry with `listUserOrganizations()` (`member=true`), `actions.admin`, or a project listing — the `organizations=<key>` filter is not membership-scoped, which is what makes validating a hand-typed key safe.

  Recovery depends on the source: `--org` always aborts; a hand-typed or empty key warns and asks again, bounded by `MAX_ORGANIZATION_ATTEMPTS` and only on a TTY; a stale key in project config falls through to `getUserSelectedOrganization()` on any stdin, since that resolves a single membership without asking. `check_failed` always aborts. On failure the just-minted token is revoked so a typo leaves no orphan; reused or hand-pasted tokens are left alone. Validation runs **after** token generation because resolving a private organization needs a token.

  Server has no organizations, so `--org` is dropped up front — before the keychain lookup, since the keychain account is derived from the organization and a kept `--org` would miss the token just saved.

## Tests

**Integration tests are the default.** Unit tests are justified only when a scenario is genuinely hard to recreate through integration tests; before writing one, consider extending the harness or fake server instead. Before writing any test, find an existing spec for the same command area and follow its structure.

- **Unit** (`tests/unit/`) — use `src/core/ui/mock.ts` for the UI layer, `tests/unit/core/host/keychain-test-handle.ts` for the keychain.
- **Integration** (`tests/integration/specs/<command>/`) — the compiled binary against fake servers, via `TestHarness`.
- **E2E** (`tests/e2e/`) — black-box tests against real dependencies that cannot be faked: OS keychain, install scripts, real server calls, external tools. `tests/e2e/context/` is the real-binary CAG suite, mostly offline against the binaries CDN (`cag-integrate.test.ts` is the exception and uses a fake SonarQube server).

### Harness

Create a fresh `TestHarness` per test and dispose it in `afterEach`; it runs the compiled binary in an isolated temp dir with a fake keychain and fake servers. Use `harness.state()` for setup beyond `withAuth`, `harness.run()` for non-interactive commands, `harness.runWithStdin()` to dump stdin and wait, and `harness.runInteractive()` for prompt-by-prompt flows (returns an `InteractiveSession` with `waitText`, `accept`/`decline`, key helpers, `waitFinish()`).

### Coverage

```bash
bun run test:coverage        # full pipeline: unit + integration + merge
bun run test:coverage:unit   # unit only (faster, no binary build needed)
```

Do **not** use `bun test --coverage` directly — Bun's native LCOV reporter emits spurious entries on non-executable lines, causing false positives in SonarQube.

## Documentation

When adding, removing, or changing commands, scripts, or project structure, update `CLAUDE.md` and `AGENTS.md` before finishing.

The docs site (`docs/`) is generated from the CLI source by post-release automation — do not hand-edit `docs/data/commands.json`, `llms.txt`, or `sitemap.xml`. Keep the fixed `<base href="/sonarqube/cli/">` in the docs HTML so production resolves relative assets under the public mount point (Netlify deploy previews served from `/` will not work with it).

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
