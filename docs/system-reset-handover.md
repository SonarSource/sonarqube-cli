# `sonar system reset` — CLI-565 Handover

This document is a handover guide for **CLI-565** (integration cleanup), the final sub-task
of the factory-reset feature (CLI-523). It summarises the overall goal, what the two
completed sub-tasks delivered, what remains, and where the existing implementation connects.

---

## Overall goal — CLI-523

`sonar system reset` is a single command that returns the CLI to factory state so users can
cleanly uninstall or recover from a broken setup. It should:

- Remove all stored credentials and server connections (auth purge)
- Uninstall downloaded binaries (sonar-secrets, CAG, sca-scanner)
- Undo integration config written by `sonar integrate` (hooks, patches, git config)
- Clear the log directory
- **Preserve telemetry** at all times

The design principle: clean up as much as possible, report whatever could not be cleaned so
the user can act on it manually. State records are only removed when the corresponding
physical cleanup has succeeded — failures stay in state so the user can retry.

The output is a `phase()` block showing one item per step with a `done`/`warn`/`pending`
status.

---

## What CLI-562 delivered — Framework remove/undo

**Branch:** merged to `master`  
**Files:** `src/cli/commands/integrate/_common/registry/`

Added the remove-side counterparts to the declarative integrations framework:

| Addition | Where | Description |
|---|---|---|
| `ResourceDeclaration.remove?(context)` | `resources/common.ts` | Optional remove hook on every resource |
| `WholeFileResource.remove()` | `resources/whole-file.ts` | Deletes the file at the resolved path |
| `JsonPatch`, `YamlPatch`, `TomlPatch` with `removePatch?` | each resource file | Calls `removePatch(doc, ctx)` if set, writes result back |
| `TextSnippet.remove()` | `resources/text-snippet.ts` | Strips the managed start/end-marker block via regex |
| `FeatureOperation.undo?` | `registry/types.ts` | Optional undo hook on operations |
| `IntegrationInstaller.removeFeature()` | `registry/installer.ts` | Drives remove on resources + reverse-ordered undo on operations |
| `RemoveFeatureCallbacks` | `registry/installer.ts` | `onResourceRemoved`, `onResourceSkipped`, `onOperationUndone` |

`removeFeature()` processes resources first (each calling `resource.remove?.()` if present),
then operations in **reverse** declaration order (each calling `operation.undo?.()`). It does
not touch dependencies — those are the caller's responsibility.

---

## What CLI-564 delivered — Command shell and non-integration reset

**Files:** `src/cli/commands/system/reset.ts`, `src/cli/command-tree.ts`

### Command and confirmation

`sonar system reset` registered under the `system` command group. Gated behind:
- **Interactive (stdin is a TTY):** must type the literal string `RESET`
- **Non-interactive:** must pass `--force`; exits with a hint otherwise

### Step result pattern

Each step returns a `StepResult`:
```typescript
interface StepResult {
  item: PhaseItem;      // shown in the phase block (done / warn / pending / info)
  cleaned: CleanedFields; // IDs of what was successfully cleaned
}
```

After all steps run, the phase renders, then:
1. `applyCleanedState(state, merged)` — subtracts cleaned IDs from state surgically
2. `clearLegacyState(state)` — unconditionally resets `state.agents` and `state.tools`
3. `saveState(state)`

### CleanedFields — the set to subtract

```typescript
interface CleanedFields {
  authConnectionIds: string[];           // connection.id for each token deleted
  dependencyIds: string[];               // dependency.id for each binary deleted
  integrationFeatures: Array<{          // feature removed per integration
    integrationStateId: string;
    featureId: string;
  }>;
  agentExtensionIds: string[];           // agentExtension.id for each removed
}
```

### What is already implemented

| Step | Status | What it does |
|---|---|---|
| `purgeAuth` | ✅ Done | Per-connection: deletes keychain token, adds `conn.id` to `authConnectionIds` on success; failed connections stay in state |
| `clearFilesystem` | ✅ Done | Removes `LOG_DIR` (`~/.sonar/sonarqube-cli/logs`) |
| `clearLegacyState` | ✅ Done | Clears `state.agents` and `state.tools` unconditionally (legacy fields, no physical artifacts) |
| `removeBinaries` | 🔲 Stub | Returns `emptyCleanedFields()` — pending CLI-565 |
| `removeAllIntegrations` | 🔲 Stub | Returns `emptyCleanedFields()` — pending CLI-565 |

### applyCleanedState — how the subtraction works

`authConnectionIds`, `dependencyIds`, `agentExtensionIds` are straightforward Set-filter
operations. Integration features use a two-level structure — grouped by integration first,
then by feature within each integration. An integration container is dropped from state only
when all of its features are removed. See `indexCleanedFeatures` and `removeCleanedFeatures`
helpers in `reset.ts`.

---

## What CLI-565 must deliver — Integration cleanup

> **Note:** The sections below are based on high-level exploration of the existing codebase.
> They are intended as orientation and starting points, not a prescriptive plan. Each area
> will require deeper investigation before implementation.

### 1. Wire `removePatch` into integration declarations (and enforce it)

All `jsonPatch`, `yamlPatch`, and `tomlPatch` resources currently lack `removePatch`, so
`removeFeature()` skips them. Each patch resource that writes entries into a shared config
file (Claude settings, MCP config, Copilot hooks JSON, Codex hooks JSON) needs a
`removePatch` function that is the inverse of its `patch` function.

As part of CLI-565, **`removePatch` should be made required** in `PatchResourceOptions`
rather than optional. Every patch resource that can be applied must also declare how to
reverse it — omitting this is a declaration bug, not a supported omission. The framework
change is small (drop the `?` from the field); the work is filling in the actual inverse
logic in each declaration.

Affected resources (non-exhaustive — verify against each declaration file):

| Integration | Resource id | File modified |
|---|---|---|
| `claude-code` | `claude-settings-sqaa-hook` | `~/.claude/settings.json` |
| `claude-code` | `claude-mcp-config` | `~/.claude/mcp.json` |
| `copilot-cli` | `copilot-hooks-config` | `.copilot/.hooks/hooks.json` |
| `copilot-cli` | MCP config resource | `.copilot/mcp.json` |
| `codex` | hooks JSON resource | `.codex/hooks.json` |
| `codex` | MCP config resource | `.codex/mcp.json` |

`wholeFile` resources already support `remove()` automatically — no changes needed for hook
scripts and instruction files.

### 2. Wire `undo` into operations

The native git integration sets `core.hooksPath` via `git config --global`. The operation
that does this needs an `undo` callback that runs `git config --global --unset core.hooksPath`.
Check `src/cli/commands/integrate/git/tools/native/index.ts` for the exact operation
declaration and add `undo` in parallel with `apply`.

### 3. Implement `removeBinaries()`

Replace the stub in `reset.ts`. For each entry in `state.dependencies.installed[]`:
- Validate the path is under `BIN_DIR` (see safety section below)
- Delete the file
- On success: add `dep.id` to `dependencyIds`
- On failure: report via the phase item (`warn` status)

Return `{ item, cleaned: emptyCleanedFields({ dependencyIds }) }`.

### 4. Implement `removeAllIntegrations()`

Replace the stub. The entry points are:

- **`ALL_INTEGRATIONS`** — `src/cli/commands/integrate/index.ts`; an array of integration
  declarations covering `claude-code`, `copilot-cli`, `codex`, `native-git`, `husky`,
  `pre-commit`.
- **`supportedIntegrations`** — a registry built from `ALL_INTEGRATIONS`; use
  `supportedIntegrations.findById(integrationId)` to look up a declaration by the
  `integrationId` stored in each `InstalledIntegration` state record.
- **`IntegrationInstaller.removeFeature(context, feature, callbacks)`** — already implemented
  in CLI-562; call once per installed feature.

The loop:

```
for each InstalledIntegration in state.integrations.installed:
  find the matching declaration via supportedIntegrations.findById(installed.integrationId)
  for each InstalledIntegrationFeature in installed.features:
    find the matching FeatureDeclaration by featureId
    reconstruct IntegrationContext from feature.targetRoot + feature.attrs
    call installer.removeFeature(context, featureDeclaration, callbacks)
    on success: collect { integrationStateId: installed.id, featureId: feature.featureId }
    on failure: leave in state (user can retry)
```

**Constructing `IntegrationContext`:** use `makeContext()` exported from
`src/cli/commands/integrate/_common/registry/install-integration.ts`. It takes
`(state, targetRoot, scope, auth, attrs)`. For reset, `auth` can be the auth from the current
state (or a best-effort null-auth stub). The `targetRoot` and `attrs` (which store
`serverUrl`, `orgKey`, `projectKey`, `scaEnabled` etc.) come directly from the
`InstalledIntegrationFeature` record.

### 5. Handle `state.agentExtensions`

`agentExtensions` is a legacy parallel track written by the old pre-framework install path
(not by the declarative installer). It holds `HookExtension`, `SkillExtension`, and
`InstructionsExtension` entries. Their physical counterparts (hook scripts, skill files) are
also declared as `wholeFile` resources in the integration declarations — so `removeFeature()`
will delete those files. However the `agentExtensions` record itself is separate.

After a successful `removeFeature()` call for a feature, also remove the corresponding
`agentExtensions` entries for that project root + agent pair and add their `id`s to
`agentExtensionIds` in `CleanedFields`. The connection between a feature and its extensions
is: same `projectRoot` (= `feature.targetRoot`) and same agent (`claude-code` /
`copilot-cli` / `codex`).

---

## Path safety — a concern requiring investigation

> **Note:** The approach below reflects a high-level understanding of the risk. The exact
> validation strategy and helper placement should be confirmed by exploring the actual path
> patterns written during integration install before committing to an implementation.

**The problem:** `InstalledIntegrationResource.path`, `InstalledIntegrationDependency.path`,
and similar fields are persisted in `state.json` at install time. State files can be
hand-edited, corrupted, or written by older CLI versions. A malformed or adversarial path
(e.g. `../../etc/passwd`, `/`, or a symlink that escapes the expected tree) must not be
deleted.

**Suggested approach — validate before every `rmSync` that consumes a path from state:**

1. Resolve symlinks first via `realpathSync(path)` so that a symlinked entry cannot escape
   its expected directory.
2. Validate the resolved path lies under a known-safe root using `path.relative()` — if the
   result starts with `..` or `path.isAbsolute(result)` is true, the path escaped the root.
3. On validation failure: warn and skip (do not throw — a single bad entry must not abort
   the whole reset). Log the rejected path for diagnosis.

Likely safe roots by context (verify actual install-time paths against this):

| Context | Expected root |
|---|---|
| Dependency binaries (`dependencyIds`) | `BIN_DIR` (`~/.sonar/sonarqube-cli/bin`) |
| Git global hook scripts | `GLOBAL_HOOKS_DIR` (`~/.sonar/sonarqube-cli/hooks`) |
| Agent global resources | Agent home dir (e.g. `~/.claude`, `~/.copilot`) |
| Project-scoped resources | `feature.targetRoot` (the project directory) |

A small helper like `isUnderSafeRoot(resolvedPath: string, roots: string[]): boolean` can be
shared by `removeBinaries` and `removeAllIntegrations`. Place it in
`src/cli/commands/system/` or `src/lib/` so both callers can reach it.

---

## Key files for CLI-565

| File | Role |
|---|---|
| `src/cli/commands/system/reset.ts` | Two stubs to implement: `removeBinaries()`, `removeAllIntegrations()` |
| `src/cli/commands/integrate/index.ts` | `ALL_INTEGRATIONS`, `supportedIntegrations` |
| `src/cli/commands/integrate/_common/registry/installer.ts` | `IntegrationInstaller.removeFeature()` |
| `src/cli/commands/integrate/_common/registry/install-integration.ts` | `makeContext()` |
| `src/cli/commands/integrate/claude/declaration.ts` | Add `removePatch` to patch resources |
| `src/cli/commands/integrate/copilot/declaration.ts` | Add `removePatch` to patch resources |
| `src/cli/commands/integrate/codex/declaration.ts` | Add `removePatch` to patch resources |
| `src/cli/commands/integrate/git/tools/native/index.ts` | Add `undo` to `core.hooksPath` operation |
| `src/lib/state.ts` | `InstalledIntegration`, `InstalledIntegrationFeature`, `AgentExtension` types |
| `src/lib/config-constants.ts` | `BIN_DIR`, `GLOBAL_HOOKS_DIR` safe-root constants |
