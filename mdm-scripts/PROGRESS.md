# MDM subcommands PoC — progress

Branch: `feature/kk/mdm-subcommands-poc` — Jira: CLI-942. Design: `SPEC.md`.

## Done

- `sonar mdm install|update|rollback|remove` (hidden, always registered) in `src/commands/mdm/`.
- `replaceBinary()` / `removeBinary()` in `src/core/host/self-replace.ts` (atomic rename on Unix; rename-aside + detached PowerShell delete on Windows).
- `--artifact-base-url` replaces the JumpCloud `SONARQUBE_CLI_ARTIFACT_BASE_URL` variable; Permissive variants map to `--skip-if-present`, `--skip-standalone-links`, `--allow-missing-checksum`, `--mdm-binary-only`.
- 12 per-OS scripts replaced by `direct-sonar-cdn/install-bootstrap.{sh,ps1}`; update/rollback/remove are one-line `sonar mdm <action>` calls.
- Test seam: `SONARQUBE_CLI_MDM_BINARY_PATH`, `SONARQUBE_CLI_MDM_USER_HOMES` (`ENV_MDM_*` in `config-constants.ts`).
- Tests: 20 unit (`tests/unit/commands/mdm/`), 37 integration (`tests/integration/specs/mdm/`, skipped on Windows). `FakeBinariesServer.publishCliArtifact()` added to the harness.
- `typecheck`, `lint`, `prettier`, full `test:integration` (before the MDM specs were added) green.

## Not verified

- Windows end to end: `install` (icacls, machine `PATH`, `WM_SETTINGCHANGE`), self-replace and delayed delete of the running exe.
- `process.execPath` in a `bun --compile` binary on Windows (works on macOS: the integration `install` copies the real binary).
- macOS `xattr -d com.apple.quarantine` only exercised indirectly.
- Bootstrap scripts against a real JumpCloud run; HelpDesk repo copies not updated.
- Full `bun run test:integration` not re-run after adding the MDM specs (only `specs/mdm`).

## Open questions (from SPEC.md)

1. `mdm remove` and the Windows machine `PATH` entry: currently left dangling (same as the old scripts).
2. `process.env.SONARQUBE_CLI_BINARIES_URL` vs explicit `--artifact-base-url`: explicit threading chosen.
3. Keep the env test seam in production code, or replace it.
4. SHA256 sidecar vs signature verification for the CLI's own artifacts: unchanged, separate decision.

## Next

1. Manual run on macOS: install → update → rollback → remove in temp paths against a real CDN mirror.
2. Windows VM run of the four actions as SYSTEM.
3. Port the bootstrap scripts into the HelpDesk JumpCloud commands.
4. Decide the open questions, then drop the `poc` from the branch name and open the PR.
