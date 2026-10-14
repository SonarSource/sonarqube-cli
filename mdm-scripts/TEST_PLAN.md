# `sonar mdm` test plan

Platforms: **U** = Linux and macOS (Unix branch), **W** = Windows. Layers:

- **H** — harness integration (`tests/integration/specs/mdm/`): compiled CLI, fake CDN, sandboxed paths (`SONARQUBE_CLI_MDM_BINARY_PATH`, `SONARQUBE_CLI_MDM_USER_HOMES`, pinned `PATH`/temp dir). Never touches the real system, so it runs everywhere, including dev machines. In sandbox mode the machine-wide Windows steps (`icacls`, machine `PATH`) are skipped.
- **E** — E2E (`tests/e2e/mdm/`): real system paths, real user enumeration, real file locks, real CDN for one scenario. Runs only when `CI=true` (or `SONARQUBE_CLI_E2E_MDM=1`) **and** the process is elevated (root / `sudo -n` / Windows admin); otherwise the suite is skipped with a logged reason. Cleans up after itself.

Artifacts: harness tests publish tiny compiled stubs (`cli-stub.ts`, versions 1.0.0 / 2.0.0 / 3.0.0, built by `setup-integration-resources.ts`) so every platform serves a real executable. Bootstrap tests serve the real CLI binary because the runner must understand `mdm install`.

## Scenarios

| ID | Scenario | Layer | Platforms |
|---|---|---|---|
| **Install** | | | |
| I1 | Copies the running CLI to the system path; the copy runs and reports the same version | H | U W |
| I2 | Installed file is mode 755 | H | U |
| I3 | Existing standalone installs become symlinks to the system binary; users without one are untouched | H | U |
| I4 | Standalone installs are never linked on Windows | H | W |
| I5 | Second run is idempotent (already-symlinked skipped); on Windows it replaces cleanly | H | U W |
| I6 | `--skip-standalone-links` leaves standalone installs alone | H | U |
| I7 | `--skip-if-present` keeps the existing binary and restores mode 755 | H | U W |
| I8 | `--skip-if-present` installs when nothing is present | H | U W |
| I9 | Overwrites an older system binary | H | U W |
| I10 | A dangling standalone symlink is replaced | H | U |
| I11 | Installed binary running `mdm install` on itself is a no-op copy | H | U W |
| I12 | Unwritable target directory fails with exit 1 and a readable message | H | U (non-root) |
| **Update** | | | |
| U1 | Installs the stable version when nothing is installed | H | U W |
| U2 | Replaces an older binary; no `.new` staging file remains | H | U W |
| U3 | Already at target: no artifact download | H | U W |
| U4 | Build-number suffix (`2.0.0.1234` vs installed `2.0.0`) counts as up to date | H | U W |
| U5 | Up-to-date no-op still restores mode 755 | H | U |
| U6 | `--force` re-downloads | H | U W |
| U7 | `--approved-version` pins the version and skips `stable.version` | H | U W |
| U8 | `.bin` 404 falls back to `.exe` | H | U |
| U9 | Checksum mismatch aborts, installed binary untouched | H | U W |
| U10 | Missing checksum file aborts | H | U W |
| U11 | `--allow-missing-checksum` proceeds with a warning; mismatch still aborts | H | U W |
| U12 | Uppercase / `hash  filename` checksum sidecar is accepted | H | U W |
| U13 | Valid checksum but not an executable: aborts **before** the swap, installed binary untouched | H | U W |
| U14 | Unpublished version, missing/garbage `stable.version`, unreachable CDN: exit 1, binary untouched | H | U W |
| U15 | Temp download directory is removed on success and on failure | H | U W |
| U16 | Installed CLI updates itself (replacing the running binary); on Windows the `.old` file disappears shortly after exit | H, E | U W |
| U17 | Real CDN: stable version downloads, real `.sha256` sidecar verifies, `--version` works | E | U W |
| **Rollback** | | | |
| R1 | Replaces a newer binary with the requested version | H | U W |
| R2 | Re-downloads even when already at that version | H | U W |
| R3 | `--version` is required; malformed versions rejected | H | U W |
| R4 | Unpublished version / checksum mismatch: binary untouched | H | U W |
| R5 | Installs when no binary exists yet | H | U W |
| R6 | Real CDN rollback to the stable version | E | U W |
| **Remove** | | | |
| D1 | Deletes system binary, every `sonar` on `PATH`, all standalone installs (incl. symlinks) | H | U W |
| D2 | Chain of copies across several `PATH` entries is removed | H | U W |
| D3 | A `sonar` on `PATH` that is not the CLI is refused and kept | H | U W |
| D4 | Nothing to remove succeeds | H | U W |
| D5 | `--mdm-binary-only` keeps PATH copies and standalone installs | H | U W |
| D6 | Installed CLI removes itself; on Windows the `.old` file disappears shortly after exit | H, E | U W |
| D7 | Dangling standalone symlink is removed | H | U |
| D8 | Windows machine `PATH` entry is **not** reverted (documents current behaviour) | E | W |
| **Lifecycle** | | | |
| L1 | install → update → rollback → remove; standalone symlink stays valid (U) / untouched (W) | H | U W |
| L2 | `mdm` hidden from root help, flags documented | H | U W |
| **Real system (E2E only)** | | | |
| S1 | Install to `/usr/local/bin/sonar` / `C:\Program Files\sonarqube-cli\bin`; non-root user can run it | E | U W |
| S2 | Real user enumeration (`dscl` / `getent` / `C:\Users`) finds the runner user's standalone install and links it (U) | E | U |
| S3 | Windows: `Authenticated Users:(RX)` granted | E | W |
| S4 | Windows: machine `PATH` contains the install dir; a fresh process resolves `sonar` | E | W |
| S5 | macOS: `com.apple.quarantine` absent after install | E | macOS |
| **Bootstrap scripts** | | | |
| B1 | Resolves `stable.version`, downloads once, verifies, runs `mdm install` | H, E | U W |
| B2 | `SONARQUBE_CLI_APPROVED_VERSION` pins the version | H | U W |
| B3 | Invalid version / non-https, non-loopback URL rejected before any download | H | U W |
| B4 | Checksum mismatch or missing checksum aborts; nothing installed | H | U W |
| B5 | Temp runner is removed on success and failure | H | U W |
| B6 | `.exe` fallback | H | U |
| B7 | Unreplaced `{{VAR}}` placeholders fall back to defaults | H | U W |

## Cannot be verified locally

Written on macOS: Windows branches (including `install-bootstrap.ps1` and everything marked W), and the Linux-only `getent` path, are verified only by CI. Linux runs are verified in Docker.
