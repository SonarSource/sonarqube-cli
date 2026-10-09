# CLI-1228 (PR 1 of 2) — Feature availability contract

## Goal

Prepare `sonar integrate` for the summary-first flow (PR 2) by replacing the inline-prompting `shouldInstall` contract with declarative availability, so the recommended set can be computed before any prompt. The prompt flow stays the same: interactive runs resolve in `custom` mode (today's per-feature prompts), and non-interactive runs resolve in `recommended` mode (today's non-interactive result).

PR 2 (out of scope here) adds the preview-first `Install recommended | Customize` prompt, the matching integration-spec updates, and the integrate docs for the new flow.

## Redesigns

1. **`shouldInstall` → `isAvailable` + `required`** on `FeatureDeclaration` / `SubfeatureDeclaration`. With the recommended path, `askUser()` no longer asks, `install()` only means "required", and `uninstall()` only means "availability lost"; inline prompting in `selection.ts` also prevents computing the recommended set before any prompt. New contract:
   - `isAvailable?: (invocation) => MaybePromise<{ available: boolean | undefined; unavailableReason?: string }>`. An omitted predicate means available; `available: undefined` means unknown (the check failed); `unavailableReason` is used only when `available` is `false`.
   - `required?: boolean`: never prompted, even under `custom`.
   - Remove `InstallDecision`, the `install`/`skip`/`uninstall`/`askUser` factories (and with them custom prompt questions: the only one, Antigravity project rules, is unreachable since Antigravity always installs globally), `normalizeDecision`, and the `nonInteractive` branches inside prompt helpers. Keep `migrationEligible`.
   - Selection splits into **evaluate** (availability for features and subfeatures up front, every unavailable reason and failed-check warning printed once) → **resolve** (`recommended` | `custom`).
2. **Git `--hook` → generic `excludedFeatureIds` on `installIntegration`.** The git command passes the other hook's id (`pre-push-hook` / `pre-commit-hook`; the ids are the same across native, husky and pre-commit). An excluded feature is treated like `undefined`: it is not prompted, installed, or removed, so `--hook pre-push` never removes an installed pre-commit hook. This removes `shouldInstallHook` (`git/tools/shared.ts`).

## Resolution rule

| Availability | Installed | `recommended` (non-interactive) | `custom` (interactive) |
|---|---|---|---|
| `false` | yes | remove; print reason if any, then `<displayName> is no longer available. Removing it.` (features and subfeatures) | same |
| `false` | no | skip, print reason if any | same |
| `undefined` | – | warn `Could not check whether <displayName> is available.`; leave as is (top-level untouched; subfeature stays active iff currently recorded) | same |
| excluded | – | leave as is, no output | same |
| `true` + `required` | – | install | install, no prompt |
| `true` | no | install | `Install X?` (No → `declined` telemetry) |
| `true` | yes | keep | top-level `Keep?` → `Proceed with removal?`; subfeature `Install X?` |

Subfeature prompts under `custom` run only when the container resolves to install. Ctrl+C → `CommandFailedError('Installation cancelled')`.

## User-visible changes

- Vortex removal prints the generic `Vortex is no longer available. Removing it.` instead of `VORTEX_UNINSTALL_MESSAGE`.
- A failed Vortex check prints the generic `Could not check whether Vortex is available.` instead of `VORTEX_CHECK_FAILED_MESSAGE`.
- Vortex unavailable messages (promotion, server unavailable, server not entitled) print during evaluation instead of before it; the two Server messages gain `Learn more: <VORTEX_PRODUCT_URL>`.
- A failed git dep-risks SCA check prints `Could not check whether pre-commit dependency-risks scan is available.`.
- Subfeatures removed for lost availability (Claude CAG hooks, git dep-risks) now print the generic removal line.
- Dep-risks unavailable reasons now include the docs link from `remediationHint`.
- A failed SCA check keeps an installed dependency-risks scan (today it is removed).
- The git "Secrets scan is required…" message is no longer printed.
- Interactive `--hook X` now asks `Install X?` for hook X (today X installs without a prompt).

## Implementation steps

Steps 1–6 change production code only; `src/` will not typecheck cleanly until step 6 completes.

1. **Contract types** (`src/core/framework/features/types.ts`, `index.ts`): replace `shouldInstall` with `isAvailable` / `required` on `FeatureDeclaration` and `SubfeatureDeclaration`; drop the `InstallDecision` and factory exports.
2. **Selection: evaluate** (`selection.ts`): remove `InstallDecision`, the `install`/`skip`/`uninstall`/`askUser` factories and `normalizeDecision`. Add `evaluateFeatures(integration, invocation, applications, excludedFeatureIds, console)`, returning for each application: `installed`, availability (`true | false | undefined`), and each subfeature's availability and recorded-active flag (from `findInstalledFeature(...).subfeatures`). Whether or not the item is installed, it prints each `unavailableReason` once (info) and, for `available: undefined`, warns `Could not check whether <displayName> is available.` Excluded features are not evaluated.
3. **Selection: resolve** (`selection.ts`): `resolveFeatureSelection(evaluation, mode: 'recommended' | 'custom', console)` returns a `FeatureSelectionResult` per the table. Keep `Keep?`/`Proceed with removal?` and `warnFeatureRemoval` for `custom`, without the `nonInteractive` branches. Print `<displayName> is no longer available. Removing it.` for installed-but-unavailable features and subfeatures in both modes.
4. **Wire into `installIntegration`** (`install-integration.ts`): add `excludedFeatureIds?: string[]`. Evaluate, then resolve with `nonInteractive ? 'recommended' : 'custom'`; the empty check and `renderInstallPreviewAndConfirm` stay as they are.
5. **Agent declarations**:
   - Vortex (`_common/vortex.ts`): map disposition `install`→`true`, `remove`→`false`, `preserve`→`undefined`. `resolveVortexSetup` stops printing the `remove`/`preserve` messages and returns the `remove` message as `unavailableReason` (passed through the agent options next to `vortexDisposition`): `VORTEX_PROMOTION_MESSAGE` (Cloud), `VORTEX_SERVER_UNAVAILABLE_MESSAGE` / `VORTEX_SERVER_NOT_ENTITLED_MESSAGE` (Server, both gaining `Learn more: ${VORTEX_PRODUCT_URL}`). Delete `VORTEX_UNINSTALL_MESSAGE` and `VORTEX_CHECK_FAILED_MESSAGE`. `VORTEX_OVER_CONSUMPTION_MESSAGE` and `VORTEX_SCA_CHECK_FAILED_MESSAGE` stay.
   - Delete the unconditional `shouldInstall: () => install()` predicates (claude `sqaa-posttooluse`, codex/opencode `sonar-sqaa-hook`).
   - Claude: rename `shouldInstallCagHook` to `isCagHookAvailable`, returning `false` only when the disposition is install and the org is not allowlisted, else `true`.
   - CAG subfeatures (`context-augmentation-feature.ts`): available iff `!isContextAugmentationSkipped()`.
   - Convert the SQAA instructions `onlyScope` gate and the Antigravity `prompt-secrets-project-rules` / `prompt-secrets-global-rules` scope gates to `isAvailable`, returning `false` on a scope mismatch. This is safe because `findInstalledFeature` matches on `scope` + `targetRoot` (`matchesFeatureKey`), so a mismatch never treats another scope's install as installed and never removes it.
   - Antigravity project rules: drop the custom question (unreachable); remove `globalAntigravityPromptSecretsRuleExists` (`antigravity/rules.ts`) if nothing else uses it. The feature stays, gated by scope only.
   - MCP server: unchanged (no predicate → available).
6. **Git declarations**:
   - `pre-commit-secrets`: `required: true`, no message.
   - Dep-risks: async `isAvailable`. SCA disabled or server too old → `{ available: false, unavailableReason }`, with the reason being the error message followed by its `remediationHint`; a failed server-version fetch or any other error → `{ available: undefined }`. Rework `scaSkipReason` to tell "SCA unavailable" apart from "check failed".
   - Hook features: remove the `shouldInstallHook` usages (native/husky/pre-commit) and the function itself.
   - `git/index.ts` `installGitFeatures` derives `excludedFeatureIds` from `options.hook`.
   - Validate: `bun run typecheck` (errors may remain only in `tests/`), `bun run lint`.
7. **⛔ STOP for review.** Report the production diff (steps 1–6) and wait. Do not start step 8 until the user explicitly confirms.
8. **Framework unit tests**: `tests/unit/core/framework/features/registry.test.ts`, `tests/unit/commands/integrate/_common/installer.test.ts`. Cover the rule table in both modes (including reason, warning and removal output), exclusion, and required subfeatures.
9. **Declaration unit tests**: `context-augmentation-feature.test.ts`, `git/git-integration-subfeatures.test.ts`, Vortex tests, and any other declaration test using `shouldInstall`. Cover dep-risks `undefined` keeping an installed scan and the Vortex messages moved into `unavailableReason`. Validate: `bun run typecheck`, `bun run lint`, `bun run test:unit`.
10. **Integration specs**: in `tests/integration/specs/integrate/git.test.ts` (plus `tests/integration/harness/environment-builder.ts` if it references the old contract), interactive `--hook` cases must now answer `Install X?`; update assertions on the changed Vortex/dep-risks messages in `tests/integration/specs/integrate/*`. Edit only; CI runs them.
11. **Docs**: in `src/core/framework/CLAUDE.md` and `src/commands/integrate/CLAUDE.md`, replace the `shouldInstall`/`askUser`/`resolveAskDecision`/`shouldInstallHook` references with the new contract.

No local integration/e2e runs.
