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

## Commands

Each command lives in `src/commands/`. The command tree is defined in `src/commands/command-tree.ts` and the entry point is `src/index.ts`.

To add a new command: add it to `src/commands/command-tree.ts` and implement the logic in a new folder under `src/commands/`.
Please declare commands using the type defined in `src/commands/_common/sonar-command.ts`.
By default, new commands should register a `authenticatedAction()`, only technical commands will use `anonymousAction()`.
Visible top-level commands use their main `description()` as root help copy. Every visible top-level command should declare `rootHelp({ category })` so the custom root menu can group commands with blank lines between the `core`, `data`, `integrate`, and `cli-management` sections. The order within each group follows the declaration order in `src/commands/command-tree.ts`, so add or move top-level commands in the desired display order there. When a visible top-level command has visible subcommands, the custom root menu derives its label automatically as `name <sub1|sub2|...>` unless that command also sets `rootHelp({ expandSubcommands: true })`, in which case the parent command is rendered as just `name` and its visible subcommands are listed individually below it. Add `rootHelp({ label })` only when the default label is not enough. If a command should disappear from help entirely, declare it with Commander `{ hidden: true }` and leave an inline comment when hiding a public compatibility command.
The bare `sonar analyze` command accepts `-p, --project <project>` for the agentic portion of the combined flow. Use it to override auto-detection or to run `sonar analyze` without an installed project integration; `--branch` remains specific to `analyze agentic` / `verify`. SQAA accepts `--depth STANDARD|DEEP`: change-set and multi `--file` default to DEEP; single `--file` defaults to STANDARD unless `--depth DEEP` is set. Per-edit hooks force STANDARD; end-of-turn instructions tell agents to always pass `--depth DEEP` (even for a single file).

`sonar analyze dependency-risks` accepts an optional `-p, --project <project>`. When omitted, the project key is auto-detected via `discoverProject()`.

`sonar analyze dependency-risks` pre-scans discovered manifest files for secrets (via `sonar-secrets`) before the SCA scan and aborts if any are found. In the `analyze` path the secrets binary is a hard prerequisite (install failure aborts the run); in the git pre-commit hook path the manifest secrets _scan_ fails open on a scan error (skips/warns). See `dependency-risk-helpers/manifest-secrets-guard.ts`. This scan-error fail-open is distinct from the git/agent secrets-hook auth+binary gate: an unauthenticated user or a missing `sonar-secrets` binary blocks the commit/push (git hooks throw `MissingDependenciesError` → exit 1).

`sonar import` (hidden while in development) imports a repository from a connected DevOps platform into SonarQube by provisioning a bound project. The organization is always the one tied to the active connection (`auth.orgKey`), and the CLI verifies the caller is an admin of that org before proceeding. Accepts exactly one selection-mode flag: `--repo <slug>` (an explicit list — the flag equivalent of interactively choosing "Manual"), `--all` (every eligible repository — equivalent to "Recommended"), or `--regex <regex>` (only eligible repositories whose DevOps platform name, not slug, matches — equivalent to "By pattern"; accepts a `/pattern/flags` literal, e.g. `/^archived-/i`, for flags like case-insensitive matching, since JS has no inline `(?i)` modifier). These three are mutually exclusive; omitting all three interactively shows a Recommended/Manual/By pattern menu. `--non-interactive` requires one of the three. On success it prints the organization's onboarding dashboard link (`{serverUrl}/organizations/{orgKey}/onboarding-dashboard`) before the final outro. Implementation lives in `src/commands/import/`.

The declarative-integration engine lives under `src/core/framework/` — it has no CLI-specific coupling, so it sits alongside `src/core/host/` rather than nested inside it: `src/core/framework/features/` (types, selection, installer, install-integration, feature-target, install-preview, completion-summary, installation-recorder, registry), `src/core/framework/resources/`, and `src/core/framework/dependencies/` (including the generic SonarSource binary dependency) as sibling modules. New integration descriptors should import from `@/core/framework/features` for dependency/resource factories, operations, and registry validation. Command handlers should keep command-specific validation, prompts, and target resolution thin, then delegate feature selection, generic install messages, dependency/resource application, and state recording to `src/core/framework/features/install-integration.ts`. Only the CAG binary dependency declaration stays in commands, at `src/commands/integrate/_common/context-augmentation-dependency.ts`, since it calls `SonarQubeClient` and CLI output helpers.

Resource removers delete an emptied file instead of leaving a husk: `text-snippet` when only whitespace remains, patch removers (`json-patch`/`yaml-patch`/`toml-patch`) when the document prunes (via `pruneEmptyContainers`) to its `defaultValue`. User/other-feature content survives pruning and keeps the file; empty parent dirs are left in place.

The registry supports a **container + thin subfeatures** model: a `FeatureContainer<TOptions>` (extending `FeatureDeclaration`) owns the centralized resource and declares a `subfeatures: SubfeatureDeclaration[]` array of deps-only features. Use `isFeatureContainer` / `selectActiveSubfeatures` from `@/core/framework/features/selection.ts` to downcast and evaluate subfeature conditions. Active subfeatures are carried on `FeatureApplication.activeSubfeatures` through the pipeline and recorded nested under `InstalledIntegrationFeature.subfeatures` in state. Binary dependencies declared by active subfeatures are collected alongside container deps and are included in the `collectReferencedDependencyIds` ref-count.

Bare `sonar integrate` (no subcommand) prompts the user to select a single integration (Claude, Copilot, Codex, Cursor, Antigravity, or Git) and delegates to that integration's handler. It accepts the shared `--project <project>` / `--global` scope flags (validated via `assertIntegrateScopeOptions()`) and forwards them to the chosen handler. Implementation in `src/commands/integrate/integrate-bare.ts`.

All `sonar integrate` subcommands share install-scope resolution via `resolveIntegrateScope()` (exported from the registry). When `--global` is omitted, interactive sessions prompt for project vs global scope after the connection/project preflight summary; `--non-interactive` defaults to project and logs an info line after that summary. An explicit project key (e.g. `--project`) implies project scope and skips the prompt. Agent handlers resolve scope at the end of `displayAgentIntegratePrelude()`; `integrate git` resolves scope after `printGitPreflightSummary()` when a repository is detected.

`sonar integrate git` accepts `--dependency-risks` + `-p <project>` to install an optional pre-commit dependency-risks (SCA) scan alongside the mandatory secrets scan. Both flags require each other; `--dependency-risks` and `-p` are not valid with `--global`. The pre-commit hook group uses the container model: the `pre-commit-hook` container feature owns the single hook resource (whose content is attr-driven and re-renders on re-run when attrs change), `pre-commit-secrets` is a mandatory thin subfeature carrying `sonar-secrets`, and `pre-commit-dependency-risks` is an optional thin subfeature carrying `sca-scanner-cli`. The project key is baked into the generated hook at install time via `attrs`. SCA is pre-commit and project-scope only — never pre-push, never `--global`. All three git strategies (native, husky, pre-commit framework) support it. The `sca-scanner-cli` binary is declared as a new `scaScannerBinaryDependency` in `src/core/framework/dependencies/sonarsource-binary.ts`.

### Agent secrets hooks

`sonar integrate claude|codex` install a prompt-submit secrets hook; `sonar integrate cursor` installs that prompt hook **plus two file-read hooks**. Each is a generated shell/PowerShell script (under `<configDir>/hooks/sonar-secrets/build-scripts/*.{sh,ps1}`) that calls a `sonar hook <agent>-<event>` handler, reads the relevant input from stdin, scans it with the `sonar-secrets` binary, and blocks when a secret is found. These hooks **fail closed** when secrets protection cannot run: the shared `resolveAuthAndSecrets()` guard (`hook-dependencies.ts`) throws `MissingDependenciesError` when the user is unauthenticated or the `sonar-secrets` binary is not installed. The hidden handlers live in `src/commands/hook/`: `agent-prompt-submit.ts` is the shared prompt core; `codex-prompt-submit.ts` and `cursor-prompt-submit.ts` are thin per-agent prompt entry points; `cursor-pre-file-read.ts` (`beforeReadFile`) and `cursor-pre-tool-use.ts` (`preToolUse`, Read tool) are Cursor's file-read handlers, sharing scan/deny helpers in `cursor-secrets-block.ts`. The prompt handlers read `stdin.prompt`; Claude/Codex emit `{ "decision": "block", "reason": ... }` while **Cursor** emits `{ "continue": false, "user_message": ... }` and exits 0. Cursor's two file-read handlers emit `{ "permission": "deny", "user_message": ..., "agent_message": ... }` and **exit 2** (Cursor's structured-block contract — only exit 2 is a deny; other non-zero codes are hook errors that fail open). On a confirmed secret they also append the file to `.cursorignore` (`cursor-ignore.ts`, relative paths resolved against cwd) so Cursor blocks subsequent reads natively. The two read hooks use different matchers — `beforeReadFile` uses `Read|TabRead` while `preToolUse` uses `Read` only (`TabRead` is not a valid `preToolUse` tool type per Cursor's docs) — so on agent `Read` events both can fire and both scan; this is deliberate defense-in-depth.

Claude and Codex build their hook feature with the shared `createSonarSecretsHooksFeature` factory (`integrate/_common/features/sonar-secrets-hooks-feature.ts`), which owns the dependency, global-skip logic, post-install example, and script-writing via its **default writer**: the nested shape `{ hooks: { <event>: [{ matcher, hooks: [{ type, command, timeout }] }] } }` (Claude `UserPromptSubmit` + `PreToolUse` in `.claude/settings.json`, Codex `UserPromptSubmit` in `.codex/hooks.json`). **Cursor does not use the factory** — its three hooks are declared inline in `integrate/cursor/declaration.ts` as a single `sonar-secrets-hooks` feature with three `wholeFile` script resources plus one `jsonPatch` that writes `.cursor/hooks.json` through `upsertCursorHooks`/`removeCursorHooks` (`integrate/cursor/hooks.ts`). Cursor's schema is flat but typed (`CursorFlatHookEntry`): `{ "version": 1, "hooks": { "<event>": [{ command, matcher, timeout, failClosed }] } }` — note an invalid matcher like `*` silently disables the hook, so matchers are pinned (`beforeReadFile`: `Read|TabRead`, `preToolUse`: `Read`, `beforeSubmitPrompt`: `UserPromptSubmit`). The helpers tolerate hand-edited `hooks.json` (non-array event values, entries with missing/non-string `command`) and preserve an existing `version`. Feature ids are per-integration (the `isFeatureInstalledGloballyForProject` global-skip probe matches on both `integrationId` and `featureId`); Claude, Codex, and Cursor all use the `sonar-secrets-hooks` id.

### Agent SQAA delivery

SonarQube Agentic Analysis (SQAA) is delivered per agent:

- **Claude Code** (project scope only, when entitled) combines one hook and end-of-turn instructions. `PostToolUse` on `Edit|Write` runs `sonar hook claude-post-tool-use --project <key>` for immediate single-file STANDARD analysis after each edit (`agent-post-tool-use.ts`); findings report via `hookSpecificOutput.additionalContext` and never block the agent (`format-sqaa-hook-context.ts`). End-of-turn DEEP change-set analysis uses the shared `buildSqaaSectionBody(projectKey)` template (`integrate/_common/instructions-templates.ts`) written into the project `CLAUDE.md` (`integrate/claude/declaration.ts` `sqaa-instructions` feature), instructing the agent to run `sonar analyze agentic --project <key>` on modified files. The CLI auto-detects the current git branch for SQAA (`branchName` on the API) when `--branch` is omitted — agents do not need to pass it; post-edit hooks use the same resolution.
- **Codex** uses a `PostToolUse` hook on `apply_patch` running `sonar hook codex-post-tool-use --project <key>` for change-set DEEP analysis after each patch (`codex-post-tool-use.ts`).
- **Copilot, Cursor, and Antigravity use instructions/rules only** — Cursor's `afterFileEdit` hook is fire-and-forget (it cannot return `additionalContext` to the conversation), so a post-edit hook would be useless for SQAA. All three write the shared `buildSqaaSectionBody(projectKey)` template (`integrate/_common/instructions-templates.ts`) telling the agent to run `sonar analyze agentic --project <key>` on modified files at end-of-turn. Cursor's `sqaa-instructions` feature (`integrate/cursor/declaration.ts`) wraps it in `.cursor/rules/sonar-agentic-analysis.mdc` with `alwaysApply: true` YAML front-matter; Copilot writes `.github/instructions/sonarqube.instructions.md`; **Antigravity** writes `.agents/rules/sonar-agentic-analysis.md` with `trigger: always_on` front-matter per [Antigravity Rules](https://antigravity.google/docs/rules-workflows). Antigravity prompt-secrets uses workspace rules (`.agents/rules/sonar-prompt-secrets.md`) and global rules (`~/.gemini/GEMINI.md` snippet) as separate integrate features.

SQAA is **project-scoped and opt-in**: integrate orchestrators call `resolveSqaaSetup()` and only install when the org is entitled and a project key is known; `resolveSqaaSetup` owns the user-facing promotion / `--global` skip messaging. Claude/Cursor/Copilot/Antigravity removers key on the `# SonarQube Agentic Analysis protocol` managed marker so teardown only deletes content the CLI wrote. SQAA project-key resolution is git-worktree-aware end to end: integrate records `attrs.repoRoot` = the repository's **main working tree** (`resolveRecordedRepoRoot`) on every project-scoped feature, while `targetRoot` stays the physical install dir for teardown; at runtime `resolveSqaaProjectKey` (`analyze/sqaa-auth.ts`) delegates to the shared worktree-aware resolver `selectRecordedFeatureForDir` (`src/core/host/recorded-feature-resolver.ts`), which maps the current directory to its working tree — and, from a linked worktree, the main working tree — then selects the recorded feature preferring a `targetRoot` (physical install dir) match over an `attrs.repoRoot` fallback, the current worktree before the main tree, and the nearest ancestor then most-recently-updated on ties. The `sonar context` passthrough uses the same resolver, so the two resolutions behave identically. So `sonar analyze agentic` resolves the key from any worktree regardless of which worktree integrate ran in.

### Context Augmentation

`sonar context [action] [args...]` is a passthrough to the locally-installed `sonar-context-augmentation` binary (CAG). It forwards args verbatim, propagates the child exit code, and injects context through `SONAR_CONTEXT_ORGANIZATION`, `SONAR_CONTEXT_PROJECT`, `SONAR_CONTEXT_TOKEN`, and `SONAR_CONTEXT_URL` env vars. Every CAG spawn (including the `--help` path and the integrate/post-update flows) also carries `SONAR_CONTEXT_INVOCATION_ID` — the per-CLI-process correlation id from `src/core/telemetry/invocation-id.ts`, shared with telemetry's `invocation_id` and forwarded by CAG to its daemon as the `x-sonar-invocation-id` header. The passthrough resolves project context from the recorded declarative CAG feature state for the current project rather than running full project auto-discovery. This lookup is git-worktree-aware so you can `sonar integrate` once and use `sonar context` from any worktree (including ones created later, and after the integrate-time worktree is removed): integrate records a stable `attrs.repoRoot` = the repository's **main working tree** (resolved via `resolveRecordedRepoRoot` in `src/core/host/git/worktree.ts`, which reads `git worktree list --porcelain`) while keeping `targetRoot` = the physical install dir for teardown; the passthrough matches the current directory (mapped to its main-worktree equivalent via `resolveWorktreeEquivalentPaths`) against `attrs.repoRoot ?? targetRoot`, falling back to `targetRoot` for state written by older CLI versions. When a recorded integration matches, the passthrough sets `SONAR_CONTEXT_WORKSPACE_ROOT` via `resolveContextWorkspaceRoot`: the **git working-tree root** containing the invocation when inside a repository (climbing up from subdirectories, including linked worktrees), or the feature's physical `targetRoot` when not in a git repo, so CAG can locate or lazily create a per-workspace daemon folder; org/project/server metadata still come from the recorded integration; it is left unset (and any inherited value dropped) when no integration matches. Implementation in `src/commands/context/`. The binary is downloaded by `sonar integrate claude` / `sonar integrate copilot` / `sonar integrate codex` / `sonar integrate antigravity` / `sonar integrate cursor` (skip with `--skip-context`); `sonar context` itself never auto-installs and emits a clear "not installed" error pointing the user back to integrate. `--global` integrations also skip CAG setup; install it by re-running `sonar integrate <agent>` from a project directory. The `--global` skip notice (`Skipping Context Augmentation: not supported with --global. Re-run without --global from a project directory to install it there.`) is only emitted when the org is actually entitled to CAG — unentitled orgs skip silently. The CLI owns the agent skill file declaratively as a `wholeFile` resource inside a single CAG feature and renders it by calling `sonar-context-augmentation tool print-skill --invocation-prefix "sonar context" --sca-enabled=<resolved>`, forwarding the recorded organization as `SONAR_CONTEXT_ORGANIZATION` (from the feature's `attrs.orgKey`, best-effort — omitted when unrecorded) so CAG's org-gated internal dogfooding tools are rendered into the skill for allowlisted organizations; project/URL/token are not passed to `print-skill`. The rendered file is written to `.claude/skills/sonar-context-augmentation/SKILL.md`, `.github/skills/sonar-context-augmentation/SKILL.md`, or `.agents/skills/sonar-context-augmentation/SKILL.md` depending on the agent. **Cursor** also writes to `.agents/skills/sonar-context-augmentation/SKILL.md` — the shared cross-tool skills directory it reads alongside Codex and Antigravity — rather than a Cursor-private `.cursor/skills` copy, so the three tools share one skill instead of duplicating it. Cursor loads skills on demand (distinct from Cursor's SQAA delivery, which is an always-applied `.cursor/rules/*.mdc` rule because that protocol must run every turn). That same feature also declares a `tool integrate --invocation-prefix "sonar context"` operation, but the operation is install-only: the framework passes `executionMode=install|update` into feature contexts, and CAG uses `shouldApply` so `tool integrate` runs during `sonar integrate <agent>` but not during post-update refreshes. Post-update still reinstalls the shared dependency, best-effort runs `sonar-context-augmentation tool stop --all` against the previously-installed binary before replacing it, and refreshes the skill file. Replay failures are debug-logged so they do not abort CLI startup.

`--help`, `-h`, and bare `sonar context` (no action) are forwarded to CAG.

Before installing, `sonar integrate claude|copilot|codex|antigravity` pre-flights a unified **Vortex** entitlement check gating both SQAA and CAG: `SonarQubeClient.hasVortexEntitlement(orgKey)` resolves the org UUID once (SonarQube Cloud only), then checks the SQAA (`/a3s-analysis/org-entitlement/{uuid}`) and CAG (`/cag/cag-entitlement/{uuid}`) endpoints in parallel via `checkSqaaEntitlement`/`checkCagEntitlement`. Each returns a shared `VortexEntitlementStatus` (`enabled`, `over_consumption`, `not_entitled`, `check_failed`), combined with precedence `check_failed > not_entitled > over_consumption > enabled`. `resolveSqaaSetup`/`resolveContextAugmentationSetup` delegate to it and install on `enabled` or `over_consumption` (skipping on `not_entitled`/`check_failed`), so consumption never blocks install — only runtime tool calls (enforced by the CAG daemon); `sonar context` is not gated.

After the CAG entitlement check passes, the integrate flow also queries SCA availability via `SonarQubeClient.getScaEnablement(connectionType, orgKey)` (`/sca/feature-enabled` on cloud, `/api/v2/sca/feature-enabled` on SonarQube Server). The resolved boolean is passed to `sonar-context-augmentation tool print-skill` as `--sca-enabled=true|false`, and is persisted on declarative feature attrs together with the recorded `serverUrl`, `orgKey`, and `projectKey` so `sonar context` and post-update can reuse the same connection metadata without re-querying the server. A check failure (network/404) emits a warn line and proceeds with `--sca-enabled=false`.

The CAG installer (`src/core/host/install/context-augmentation.ts`) handles `.tar.gz` archives: download → verify detached `.asc` PGP signature → gunzip + USTAR-extract the inner binary into `~/.sonar/sonarqube-cli/bin/`. Tar reading is in `src/core/host/install/tar.ts` (no external dep). The pinned CAG version is in `package.json#externalBinaries["sonar-context-augmentation"]` and `src/core/host/signatures.ts`. In the declarative framework, the CAG binary is managed as a shared dependency (`sonar-context-augmentation`), while a single declarative feature owns both the skill file resource and the install-only `tool integrate` operation with the invocation prefix forced to `sonar context`.

### System reset

`sonar system reset` returns the CLI to a factory-like state in one shot. Registered as `anonymousAction` so it works when auth is broken. Implementation is split across `src/commands/system/reset.ts` (orchestration), `reset-auth.ts`, `reset-binaries.ts`, `reset-integrations.ts`, `reset-filesystem.ts`, and `safe-path.ts`. Integration teardown is declarative-only: `integrations.installed` features are removed via `removeFeature()`; legacy `agentExtensions` entries are cleared from state in `clearLegacyState()` but are not used for on-disk cleanup (1.0 does not guarantee removal of pre-declarative artifacts). Binary cleanup removes paths from both `dependencies.installed` and legacy `tools.installed` under `BIN_DIR`. Partial reset (step warnings) exits `0`.

### Telemetry

All telemetry events (`CliCommandExecuted` from `storeEvent`, `CliAnalysisCompleted`, `CliIntegrationConfigured`) are appended to `telemetry-events.ndjson` in `src/core/telemetry/telemetry-events.ts` and drained by `flushTelemetryEvents`, sharing the tiered identity resolver in `src/core/telemetry/identity.ts`. Each analyzer run (sonar-secrets, SQAA, SCA) emits exactly one `CliAnalysisCompleted` event; its required `details` field carries a JSON-encoded, analyzer-specific per-rule blob when `findings_count > 0` and is `""` (empty string, never `null`, so `flushTelemetryEvents`'s null-stripping replacer keeps the column) otherwise. Each analyzer helper builds its own `details`; the shared emitter stays analyzer-agnostic. It fills `connection_type`, `user_uuid`, `organization_uuid_v4`, and `sqs_installation_id` on every event — including env-var auth (`SONARQUBE_CLI_TOKEN` + `SONARQUBE_CLI_ORG` or `SONARQUBE_CLI_SERVER`) where those fields were previously always null.

**Resolution order** (per auth token, keyed by connection type + server URL + org key + token fingerprint):

1. **Connection seed** — `identityFromConnection()` maps `AuthConnection.userUuid`, `organizationUuidV4`, and `sqsInstallationId` (populated at `sonar auth login` via `getCurrentUser()`, `getOrganizationId()`, and `getSystemStatus()`).
2. **Disk cache** — `{SONAR_USER_HOME}/sonarqube-cli/telemetry/identity-cache.json`, one entry per auth fingerprint. Avoids repeat API calls across CLI invocations.
3. **API enrichment** — `SonarQubeClient.getSafe()` fetches only missing fields: `/api/users/current` (cloud and server), `/organizations/organizations` (cloud only, when `orgKey` is set), `/api/system/status` (server only).

**Fast paths** (skip keychain / `resolveFromState()`):

- Env-var auth when `isEnvBasedAuth()` is true — uses `resolveFromEnv()` directly; partial env (token only) does not warn during silent `storeEvent`.
- Logged-in user when the active connection already satisfies `needsIdentityEnrichment()` — complete required fields plus `user_uuid` resolved (present, or login persisted `userUuid: null`).

**Field completeness** (`isIdentityCompleteForConnection`):

- **Cloud** — requires `user_uuid` and `organization_uuid_v4`.
- **Server** — requires `sqs_installation_id` only; `user_uuid` is optional on older SonarQube Server versions that do not return it (see `TelemetryEventPayload`).

**`user_uuid` policy** — always attempted for cloud and server (login and env-var auth) whenever not already known. Login stores `userUuid` on the connection (`string` or explicit `null` after a successful login-time fetch). Telemetry skips re-fetch when `conn.userUuid !== undefined`. Legacy connections without that field, and all env-var sessions, resolve via the API path. A successful API response with no user id is cached as confirmed-absent (`userUuid: null` in the disk entry) so old servers do not cause infinite re-fetch; transient API failures are not cached and retry on the next command.

**Caching rules** — disk entries are written only when the API call succeeded (`response.ok`). Non-null values and confirmed-absent nulls are persisted; failed/transient responses are omitted so the next run retries. The `'fieldName' in entry` check in `planFieldsToFetch()` distinguishes “not yet tried” from “confirmed absent”.

## Error handling

Please use the exception types defined in `src/core/command-error.ts` for production code. If you need to throw an error from a mock in test code, it's fine to use the generic `Error` type.

Error subclasses extend the abstract `CliError` and carry their own `exitCode`, which `SonarCommand.runCommand()` forwards to `process.exitCode`:

- `InvalidOptionError` → exit code `2` (conflicting or invalid CLI options).
- `CommandFailedError` → exit code `1` by default, or whatever is passed to the constructor.
- Any other `Error` caught by `runCommand` → exit code `1`.

`CliError` also supports an optional `remediationHint`. When present, `SonarCommand.runCommand()` prints the error message first, then renders the hint on a separate `💡` line.

## State and auth

- Persistent state (server URL, org, project) is managed via `src/core/state/state-manager.ts`.
- `loadState()` returns defaults only when `state.json` is absent; if an existing file fails to read/parse it retries then throws (so `saveState()` can't wipe a corrupt file — CLI-834). Best-effort callers (Sentry init, `storeEvent`/`flushTelemetry`, `runPostUpdateActions`) use `tryLoadState()`, which returns `null` on failure.
- Declarative integration installs are tracked as integration entries in the top-level `integrations.installed` state registry, with installed feature targets nested under each integration. Shared declarative dependencies (for example SonarSource binaries required by multiple features) are recorded separately in `dependencies.installed` and referenced from features by id. This is the generic state surface for Git, Claude, Codex, Copilot, Antigravity, and future integrations; legacy `agents` and `agentExtensions` remain for compatibility.
- Tokens are stored in the system keychain via `src/core/host/keychain.ts` — never store tokens in plain files.
- All path and URL constants live in `src/core/config-constants.ts` — import from there instead of hardcoding.
- Shared Sonar product data lives under `~/.sonar`; CLI-specific data stays under `~/.sonar/sonarqube-cli`, and the stable anonymous telemetry user ID is shared at `~/.sonar/user`. `SONAR_USER_HOME` is only a late-bound override for state persistence and telemetry user-id codepaths; other exported path constants remain fixed after import.
- Caller-agent hints (Cursor, Claude Code, Copilot CLI, Codex, or Antigravity) from the environment: `src/core/host/agent-detector.ts` (`detectCallerAgent`, etc.).
- `sonar auth logout` relies on state: if there is no active connection or `isAuthenticated` is false, it only reports that you are already logged out (no keychain changes).
- When `sonar auth login` runs the browser-based OAuth flow, the server-generated token name returned in the callback POST body is captured and persisted on the connection as `tokenName` (see `AuthConnection` in `src/core/state/state.ts`). The wire field is `name` (matching `/api/user_tokens/revoke?name=`); we keep it as `tokenName` in-memory to disambiguate from other "name" fields.
- On `sonar auth logout`, the CLI best-effort revokes the server-side token via `SonarQubeClient.revokeUserToken(...)` (a one-line wrapper over the generic `postForm(endpoint, params)` helper) before clearing the keychain entry. Failures (network error, non-2xx response) are reported via a warning on stderr; local cleanup still proceeds. When the connection has no `tokenName` (e.g. upgraded from an older CLI version), the CLI emits a manual-revocation hint on stderr instead.
- `sonar system status` displays a diagnostic overview: authentication (token verified live via `/api/authentication/validate`, four states: Not Set / Active / Invalid / Set Unverified), installed binaries with update availability, configured integrations with paths, and MCP Server configured/running status. Supports `--json` for machine consumption. Implementation in `src/commands/system/status.ts`. Token verification uses `checkTokenStatus` from `_common/token.ts`; CLI update availability comes from `Distribution/sonarqube-cli/stable.version`, while `sonar update` downloads the platform installer script from the GitHub `user-scripts/` directory when it actually performs the update. MCP config validation is JSON-based for Claude/Copilot (checks `mcpServers.sonarqube` structure) and trusts file existence for Codex TOML configs.
- `sonar self-update` is a deprecated, hidden alias for `sonar update` (only when `CURRENT_DISTRIBUTION.enableSelfUpdate` is true; see `src/core/host/distribution.ts`): calling it prints a deprecation warning pointing to `sonar update`, then runs the same `updateVersion()` logic. Both are registered in `src/commands/command-tree.ts`.

## Tests

### Philosophy

**Integration tests are the default.** Unit tests are justified only when a situation is genuinely hard to recreate via integration tests due to test setup complexity. Before writing a unit test, first consider extending the harness or fake server infrastructure to handle the scenario. Unit tests are a last resort.

Follow the structure of existing tests for the command or feature area you are working in.

- Unit tests: `tests/unit/` — use `src/core/ui/mock.ts` for UI layer, `tests/unit/core/host/keychain-test-handle.ts` for keychain.
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

The docs site is generated from the CLI source — do not edit `commands.json`, `llms.txt`, or `sitemap.xml` by hand. This is done by automation post-release. The docs generator also stamps the current package version into the nav badge in `index.html` and `commands.html`, plus the JSON-LD `softwareVersion` and `meta-version` in `index.html`.
Keep a fixed `<base href="/sonarqube/cli/">` in the docs HTML so production resolves relative assets and internal links under the public mount point. This is intentionally production-oriented: Netlify deploy previews served from `/` will not work with that fixed base.

<!-- sonar:begin:sonarqube-agentic-analysis-protocol -->

# SonarQube Agentic Analysis protocol

SonarQube Agentic Analysis is the final confirmation layer at the end of every turn in which you wrote to one or more files in the workspace (create, edit, patch, format — any tool call that changed file contents on disk).

**Trigger:** the moment before you send your final reply for the turn.

When the trigger fires, you **MUST** run SonarQube Agentic Analysis on the full set of files you modified this turn — **one command, not a per-file loop**.

**Preferred:** pass every path you modified this turn in a single invocation (repeat `--file` for each path). Use paths **relative to the project root** (e.g. `src/foo.ts`). For end-of-turn analysis, **always** pass `--depth DEEP` — even when you changed only one file — so cross-file findings are included.

```bash
sonar analyze agentic --project SonarSource_sonarqube-cli --depth DEEP --file <path/to/file1> --file <path/to/file2>
```

**Fallback:** when you cannot reliably list every modified path (e.g. you did not track them, or git state is the only source of truth), use the git change set with DEEP analysis:

```bash
sonar analyze agentic --project SonarSource_sonarqube-cli --depth DEEP
```

Per-edit hooks run faster STANDARD analysis. End-of-turn analysis must always use `--depth DEEP` (including a single `--file`). Use `--depth STANDARD` only for optional faster passes — never for the mandatory end-of-turn run.

Non-negotiable rules:

1. Mid-turn edits do **not** need SonarQube Agentic Analysis — only the final on-disk state matters. Skipping SonarQube Agentic Analysis at end-of-turn is a protocol violation.
2. Run SonarQube Agentic Analysis **before** sending your final reply, marking the task done, or handing control back to the user.
3. If SonarQube Agentic Analysis reports issues on lines you touched in this turn, fix them, then re-run SonarQube Agentic Analysis on the same scope (change set or explicit file list). Repeat until clean (or only pre-existing findings on lines you did not touch remain). Pre-existing findings on untouched lines are out of scope — do not "fix" them unless the user asked.
4. If SonarQube Agentic Analysis is skipped (no SonarQube Cloud connection, or no project configured), state the skip reason to the user once and continue — do not retry.
5. Do not suppress, summarize away, or omit SonarQube Agentic Analysis findings from your reply. Surface them verbatim.

<!-- sonar:end:sonarqube-agentic-analysis-protocol -->
