# CLI-1228 (PR 1 of 2) — Feature availability contract

## Goal

Prepare `sonar integrate` for the summary-first flow (PR 2) by replacing the inline-prompting `shouldInstall` contract with declarative availability, so the recommended set can be computed before any prompt. The prompt flow stays the same: interactive runs resolve with `useRecommended: false` (today's per-feature prompts), and non-interactive runs resolve with `useRecommended: true` (today's non-interactive result).

PR 2 (out of scope here) adds the preview-first `Install recommended | Customize` prompt, the matching integration-spec updates, and the integrate docs for the new flow.

## Redesigns

1. **`shouldInstall` → `isAvailable` + `required`** on `FeatureDeclaration` / `SubfeatureDeclaration`. With the recommended path, `askUser()` no longer asks, `install()` only means "required", and `uninstall()` only means "availability lost"; inline prompting in `selection.ts` also prevents computing the recommended set before any prompt. New contract:
   - `isAvailable?: (invocation) => MaybePromise<{ available: boolean | undefined; unavailableReason?: string }>`. An omitted predicate means available; `available: undefined` means unknown (the check failed); `unavailableReason` is used only when `available` is `false`.
   - `required?: boolean`: never prompted, even when not using the recommended set.
   - Remove `InstallDecision`, the `install`/`skip`/`uninstall`/`askUser` factories (and with them custom prompt questions: the only one, Antigravity project rules, is unreachable since Antigravity always installs globally), `normalizeDecision`, and the `nonInteractive` branches inside prompt helpers. Keep `migrationEligible`.
2. **Availability and active subfeatures live on `FeatureApplication`.** Today the selected subfeature set reaches the installer as a copy of the container with `subfeatures` narrowed to the active ones, so `feature.subfeatures` means "declared" in some places and "active" in others (the installer re-looks up the declared container to tell them apart). New shape:
   ```ts
   interface FeatureApplication {
     feature; targetRoot; scope; auth; force; attrs; // as today; feature is always the declared one
     installed: boolean;
     available: boolean | undefined;
     unavailableReason?: string;
     subfeatureApplications: SubfeatureApplication[];
   }
   interface SubfeatureApplication {
     subfeature: SubfeatureDeclaration;
     installed: boolean; // recorded on the installed container
     available: boolean | undefined;
     unavailableReason?: string;
     active: boolean;
   }
   ```
   `installIntegration` then runs three stages: **build** (`buildApplications` resolves target/scope plus availability and installed state; prints nothing) → **report** (prints every reason, failed-check warning and removal line) → **resolve** (decides and prompts only). Reconcile builds applications with `installed: true`, `available: undefined` and `active` from recorded ids, which opens the door to availability-aware post-update later.
3. **Git `--hook` → generic `excludedFeatureIds` on `installIntegration`.** The git command passes the other hook's id (`pre-push-hook` / `pre-commit-hook`; the ids are the same across native, husky and pre-commit). Excluded features are dropped at build: not reported, prompted, installed, or removed, so `--hook pre-push` never removes an installed pre-commit hook. This removes `shouldInstallHook` (`git/tools/shared.ts`).
4. **Vortex disposition carries its message.** `vortexDisposition: { action: 'install' | 'preserve' | 'remove'; unavailableReason?: string }`, so `resolveVortexSetup` stops printing its availability messages and the framework reports them.

## Resolution rule

| Availability | Installed | `useRecommended` (non-interactive) | not `useRecommended` (interactive) |
|---|---|---|---|
| `false` | yes | remove; print reason if any, then `<displayName> is no longer available. Removing it.` | same |
| `false` | no | skip, print reason if any | same |
| `undefined` | – | warn `Could not check whether <displayName> is available.`; leave as is (top-level untouched; subfeature stays active iff installed) | same |
| excluded | – | leave as is, no output | same |
| `true` + `required` | – | install | install, no prompt |
| `true` | no | install | `Install X?` (No → `declined` telemetry) |
| `true` | yes | keep | top-level `Keep?` → `Proceed with removal?`; subfeature `Install X?` |

Applies to features and subfeatures alike. Subfeature availability is checked only when the container is available; subfeature prompts run only when the container resolves to install. Ctrl+C → `CommandFailedError('Installation cancelled')`.

## User-visible changes

- Vortex removal prints the generic `Vortex is no longer available. Removing it.` instead of `VORTEX_UNINSTALL_MESSAGE`.
- A failed Vortex check prints the generic `Could not check whether Vortex is available.` instead of `VORTEX_CHECK_FAILED_MESSAGE`.
- Vortex unavailable messages (promotion, server unavailable, server not entitled) print during the report stage instead of before the flow; the two Server messages gain `Learn more: <VORTEX_PRODUCT_URL>`.
- Subfeatures removed for lost availability (Claude CAG hooks, git dep-risks) now print the generic removal line.
- Dep-risks unavailable reasons now include the docs link from `remediationHint`.
- A failed SCA check keeps an installed dependency-risks scan (today it is removed) and prints `Could not check whether pre-commit dependency-risks scan is available.`.
- The git "Secrets scan is required…" message is no longer printed.
- Interactive `--hook X` now asks `Install X?` for hook X (today X installs without a prompt).

## Implementation steps

Steps 1–8 change production code only; `src/` will not typecheck cleanly until step 8 completes. Every step that changes files gets its own snapshot.

1. **Contract types** (`src/core/framework/features/types.ts`, `index.ts`): replace `shouldInstall` with `isAvailable` / `required` on `FeatureDeclaration` and `SubfeatureDeclaration` (export a `FeatureAvailability` type); add the new `FeatureApplication` fields and `SubfeatureApplication`; drop the `InstallDecision` and factory exports.
2. **Build** (`feature-target.ts` `buildApplications`): take `state`, `integration` and `excludedFeatureIds`; drop excluded features; fill `installed` (`findInstalledFeature`), `available` / `unavailableReason`, and `subfeatureApplications` (each subfeature's `installed` from the recorded container, availability only when the container is available, `active: false`). Prints nothing.
3. **Report** (`selection.ts`): one function printing, for features and subfeatures, each `unavailableReason` (info), `Could not check whether <displayName> is available.` (warn) for `available: undefined`, and `<displayName> is no longer available. Removing it.` (info) for installed-but-unavailable items.
4. **Resolve** (`selection.ts`): remove `InstallDecision`, the factories and `normalizeDecision`. `resolveFeatureSelection(applications, useRecommended: boolean, console)` returns a `FeatureSelectionResult` per the table, setting `active` on subfeature applications. Keep `Keep?`/`Proceed with removal?` and `warnFeatureRemoval` for the non-recommended path, without the `nonInteractive` branches. No availability logic and no reporting here.
5. **Installer reads active subfeatures** (`installer.ts`, `installation-recorder.ts`, `install-preview.ts`, `reconcile.ts`): replace every read of the narrowed `feature.subfeatures` with active `subfeatureApplications` — dependency/resource/operation collection, stale-subfeature teardown (no more declared-container re-lookup), `activeSubfeatures` on the context, recording, preview active ids. Reconcile sets `installed: true`, `available: undefined`, and `active` from recorded ids instead of building a narrowed copy.
6. **Wire into `installIntegration`** (`install-integration.ts`): add `excludedFeatureIds?: string[]`; build → report → resolve with `useRecommended: nonInteractive === true`; progress output reads active `subfeatureApplications`; the empty check and `renderInstallPreviewAndConfirm` stay as they are.
7. **Agent declarations**:
   - Vortex (`_common/types.ts`, `_common/vortex.ts`, claude/antigravity/postlude callers): `vortexDisposition` becomes `{ action, unavailableReason? }`. `isAvailable` maps `install`→`true`, `remove`→`false` (with `unavailableReason`), `preserve`→`undefined`. `resolveVortexSetup` stops printing the `remove`/`preserve` messages and returns the `remove` message as `unavailableReason`: `VORTEX_PROMOTION_MESSAGE` (Cloud), `VORTEX_SERVER_UNAVAILABLE_MESSAGE` / `VORTEX_SERVER_NOT_ENTITLED_MESSAGE` (Server, both gaining `Learn more: ${VORTEX_PRODUCT_URL}`). Delete `VORTEX_UNINSTALL_MESSAGE` and `VORTEX_CHECK_FAILED_MESSAGE`. `VORTEX_OVER_CONSUMPTION_MESSAGE` and `VORTEX_SCA_CHECK_FAILED_MESSAGE` stay.
   - Delete the unconditional `shouldInstall: () => install()` predicates (claude `sqaa-posttooluse`, codex/opencode `sonar-sqaa-hook`).
   - Claude: rename `shouldInstallCagHook` to `isCagHookAvailable`, returning `false` only when the disposition action is install and the org is not allowlisted, else `true`. Remove the stale "allowlist never tears an existing hook down" comment.
   - CAG subfeatures (`context-augmentation-feature.ts`): available iff `!isContextAugmentationSkipped()`.
   - Convert the SQAA instructions `onlyScope` gate and the Antigravity `prompt-secrets-project-rules` / `prompt-secrets-global-rules` scope gates to `isAvailable`, returning `false` on a scope mismatch. This is safe because `findInstalledFeature` matches on `scope` + `targetRoot` (`matchesFeatureKey`), so a mismatch never treats another scope's install as installed and never removes it.
   - Antigravity project rules: drop the custom question (unreachable); remove `globalAntigravityPromptSecretsRuleExists` (`antigravity/rules.ts`) if nothing else uses it. The feature stays, gated by scope only.
   - MCP server: unchanged (no predicate → available).
8. **Git declarations**:
   - `pre-commit-secrets`: `required: true`, no message.
   - Dep-risks: async `isAvailable`. Add `ScaServerVersionUnknownError` (subclass of `CommandFailedError`, `sca-availability.ts`), thrown only for the failed server-version fetch so other `assertScaAvailable` callers are unaffected. Server too old or SCA not enabled → `{ available: false, unavailableReason }` (error message followed by its `remediationHint`); `ScaServerVersionUnknownError` or any other error → `{ available: undefined }`.
   - Hook features: remove the `shouldInstallHook` usages (native/husky/pre-commit) and the function itself.
   - `git/index.ts` `installGitFeatures` derives `excludedFeatureIds` from `options.hook`.
   - Validate: `bun run typecheck` (errors may remain only in `tests/`), `bun run lint`.
9. **⛔ STOP for review.** Report the production diff (steps 1–8) and wait. Do not start step 10 until the user explicitly confirms.
10. **Framework unit tests**: `tests/unit/core/framework/features/registry.test.ts`, `tests/unit/commands/integrate/_common/installer.test.ts`, and any test building `FeatureApplication`s or narrowed containers by hand. Cover the rule table in both modes (including reason, warning and removal output), exclusion, required subfeatures, active subfeature application, and reconcile.
11. **Declaration unit tests**: `context-augmentation-feature.test.ts`, `git/git-integration-subfeatures.test.ts`, Vortex tests, and any other declaration test using `shouldInstall`. Cover dep-risks `undefined` keeping an installed scan and the Vortex messages moved into `unavailableReason`. Validate: `bun run typecheck`, `bun run lint`, `bun run test:unit`.
12. **Integration specs**: in `tests/integration/specs/integrate/git.test.ts` (plus `tests/integration/harness/environment-builder.ts` if it references the old contract), interactive `--hook` cases must now answer `Install X?`; update assertions on the changed Vortex/dep-risks messages in `tests/integration/specs/integrate/*`. Edit only; CI runs them.
13. **Docs**: in `src/core/framework/CLAUDE.md` and `src/commands/integrate/CLAUDE.md`, replace the `shouldInstall`/`askUser`/`resolveAskDecision`/`shouldInstallHook`/narrowed-subfeature references with the new contract and stages.

No local integration/e2e runs.
