# MDM subcommands PoC — progress

Branch: `feature/kk/mdm-subcommands-poc` — Jira: CLI-942. Design: `SPEC.md`. Test scenarios: `TEST_PLAN.md`.

## Done

- `sonar mdm install|update|rollback|remove` (hidden, always registered) in `src/commands/mdm/`.
- `replaceBinary()` / `removeBinary()` in `src/core/host/self-replace.ts` (atomic rename on Unix; rename-aside + detached PowerShell delete on Windows).
- `--artifact-base-url` replaces the JumpCloud `SONARQUBE_CLI_ARTIFACT_BASE_URL` variable; Permissive variants map to `--skip-if-present`, `--skip-standalone-links`, `--allow-missing-checksum`, `--mdm-binary-only`.
- 12 per-OS scripts replaced by `direct-sonar-cdn/install-bootstrap.{sh,ps1}`; update/rollback/remove are one-line `sonar mdm <action>` calls. The bootstrap scripts accept `http://` for loopback base URLs only.
- `update`/`rollback` now run the downloaded binary's `--version` before the swap, so a checksum-valid but broken artifact cannot replace a working install (found while writing U13).
- Test seams: `SONARQUBE_CLI_MDM_BINARY_PATH`, `SONARQUBE_CLI_MDM_USER_HOMES` (`ENV_MDM_*`); sandbox mode skips the Windows `icacls` / machine `PATH` steps.

## Tests (see `TEST_PLAN.md` for the scenario matrix)

- Unit: `tests/unit/commands/mdm/` (20).
- Harness integration, all platforms: `tests/integration/specs/mdm/` (68 tests: install, update/rollback, remove, lifecycle, bootstrap scripts). Fake releases are compiled stubs built by `setup-integration-resources.ts`.
- Real-system E2E: `tests/e2e/mdm/` (12 tests). Gated to CI / `SONARQUBE_CLI_E2E_MDM=1`, elevated, no existing install.

## Verified

- macOS arm64: unit 20/20, harness 66 pass (2 Windows-only skipped), E2E correctly skipped.
- Linux arm64 in Docker, as a non-root user with passwordless `sudo` (the CI shape): harness 66 pass, E2E 8 pass (4 Windows/macOS-only skipped), including `mdm update` + `rollback` against the real CDN and the real user database (`getent`).

## Not verified (CI is the first run)

- Every Windows test and branch: `install` (`icacls`, machine `PATH`, `WM_SETTINGCHANGE`), rename-aside self-replace, delayed delete of the running exe, `install-bootstrap.ps1`.
- `process.execPath` in a Windows `--compile` binary.
- Linux x86-64 (only arm64 was run); macOS E2E (`xattr`) never runs on CI.
- Full `bun run test:integration` and `test:e2e` after these changes.

## Open questions (from SPEC.md)

1. Decided: `mdm remove` now also removes the install directory from the Windows machine `PATH` (behaviour change vs. the old scripts; covered by an E2E test, Windows unverified).
2. Keep the env test seam in production code, or replace it.
3. SHA256 sidecar vs signature verification for the CLI's own artifacts: unchanged, separate decision.
4. Real bootstrap against the real CDN waits for a release that contains `sonar mdm`.

## Next

1. Let CI run the Windows jobs; fix whatever the first Windows run finds.
2. Port the bootstrap scripts into the HelpDesk JumpCloud commands.
3. Decide the open questions, then drop `poc` from the branch name and open the PR.
