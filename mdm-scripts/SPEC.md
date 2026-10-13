# Spec: move MDM lifecycle logic from shell scripts into the CLI binary

## Context

`mdm-scripts/direct-sonar-cdn/` currently holds 12 files: 4 lifecycle actions
(`install`, `update`, `rollback`, `remove`) × 3 OS directories (`macos/`, `linux/`,
`windows/`), each a full bash or PowerShell implementation. JumpCloud (our MDM)
runs these as Custom Commands, always as root/SYSTEM, parameterized via JumpCloud
Custom Variables that get textually substituted into the script (`{{VAR_NAME}}`)
before execution.

Problem: this is the same logic (download artifact, verify checksum, place
binary, edit PATH, enumerate local users, symlink per-user standalone installs)
duplicated three times in two languages (bash for macOS+Linux — already mostly
unified there — and PowerShell for Windows), and it will keep drifting because
every change has to be made and tested three times.

Goal: **one implementation, in the CLI's existing TypeScript/Bun codebase**,
exposed as new `sonar mdm <action>` subcommands. JumpCloud's own script bodies
shrink to near-trivial one-liners. OS-specific behavior becomes `if
(process.platform === 'win32')` branches inside one TS module, not parallel
script files.

This spec is meant to be handed to an implementing agent with no prior context
on this discussion — it's self-contained. It does not itself write code.

## Current state (what must be preserved, behaviorally)

All four actions currently live under `mdm-scripts/direct-sonar-cdn/{macos,linux,windows}/`.
Read the actual files before implementing — this is a summary, not a substitute.

### `install.sh` / `install.ps1` (macOS, Linux, Windows — 3 near-identical implementations)

1. Resolve target version: `SONARQUBE_CLI_APPROVED_VERSION` JumpCloud variable if
   set (validated against `^[0-9][0-9.]*$`), else fetch
   `https://binaries.sonarsource.com/Distribution/sonarqube-cli/stable.version`.
2. Download the platform artifact (`sonarqube-cli-<version>-<platform>.bin`, with a
   legacy `.exe` fallback — comment says "remove once .bin is released", check if
   still relevant) from `<ARTIFACT_BASE_URL>/<version>/<os>/<basename>.bin`.
3. Verify SHA256 against the sibling `.bin.sha256` file fetched from the same base
   URL. Abort on mismatch or on failure to fetch the expected hash.
4. `chmod +x`; on macOS additionally strip `com.apple.quarantine` via `xattr -d`.
5. Move into place: `/usr/local/bin/sonar` (macOS/Linux) or
   `C:\Program Files\sonarqube-cli\bin\sonar.exe` (Windows).
6. Windows only: grant `Authenticated Users:(RX)` via `icacls` (binary was written
   by SYSTEM, default ACL may exclude regular users), and add the install dir to
   the **machine** `PATH` env var (`[Environment]::SetEnvironmentVariable('Path',
   ..., 'Machine')`), then broadcast `WM_SETTINGCHANGE` via `SendMessageTimeout` so
   running shells/Explorer pick it up without logoff. macOS/Linux do **not** touch
   PATH — `/usr/local/bin` is assumed already on it.
7. Enumerate local user home directories (`dscl . list /Users NFSHomeDirectory` on
   macOS, `getent passwd` on Linux, `Get-ChildItem C:\Users` on Windows) and, for
   each one that already has a standalone install
   (`~/.local/share/sonarqube-cli/bin/sonar` / `%LocalAppData%\sonarqube-cli\bin\sonar.exe`),
   replace it with a symlink to the MDM binary — so PATH order can never let a
   stale standalone copy win. This is done directly by the root/SYSTEM process; it
   is **not** a `sudo -u`/`runas` re-execution as that user, just root writing into
   each user's home directory.

### `update.sh` / `update.ps1`

Same download+verify+place logic as install, plus:
- `SONARQUBE_CLI_FORCE` JumpCloud variable (boolean-ish, `"true"` string):
  if the currently-installed MDM binary's version (via `sonar --version`,
  3-segment semver comparison) already equals the target, skip unless forced.
- If the MDM binary isn't present yet, installs it (same as `install`).
- Does **not** re-run the per-user symlink step (only `install` does — on Windows
  the comment notes a user's own `sonar update`/self-update can overwrite the
  symlink with a real binary, and the next daily MDM `install` run re-symlinks it).
- Does not touch PATH (assumes `install` already did it).

### `rollback.sh` / `rollback.ps1`

Same download+verify+place logic, targeting a **required** version:
`SONARQUBE_CLI_ROLLBACK_VERSION` (no default/latest fallback — validated
`^[0-9][0-9.]*$`, script errors out if unset). No force flag concept, no
already-at-version short-circuit — always re-downloads and replaces.

### `remove.sh` / `remove.ps1`

1. Delete the MDM binary path. Error if it's still present after deletion.
2. Loop: while `sonar` still resolves on `PATH` (`command -v` / `Get-Command`),
   sanity-check it looks like the real CLI (`--version` output matches
   `\d+\.\d+\.\d+`) — refuse to touch it otherwise — then delete it. Repeats to
   catch Homebrew installs, manually-added PATH entries, etc.
3. Enumerate local users (same mechanism as install) and delete their standalone
   install path if present.
4. Does not revert the PATH edit made by `install` on Windows (not currently
   handled — note this, don't silently change behavior without flagging it).

### Already-existing, related code (read before building anything new)

- `src/commands/update/update-check.ts` + `src/commands/update/index.ts` — the
  existing `sonar update` / `sonar update status` command. **This is not a
  pattern to copy.** It downloads `user-scripts/install.sh` /
  `user-scripts/install.ps1` from GitHub and re-executes it as a subprocess (on
  Windows, by spawning a **visible new PowerShell window** because the running
  `sonar.exe` is file-locked and the parent must exit for the script to
  overwrite it). This is the same "OS-dialect script" problem we're trying to
  eliminate for the MDM path, and it depends on an interactive session
  (visible window) that MDM automation won't have. Do not reuse this
  mechanism for `sonar mdm update`/`rollback` — it's cited here only so the
  new code isn't confused with it.
- `user-scripts/install.sh` — the **standalone** (non-MDM) per-user installer.
  Single bash script already covers both macOS and Linux (`detect_os` branches
  internally) — this is the existing precedent for "one shell file covers two
  Unix flavors," worth mirroring for the new MDM bootstrap.
- `src/core/host/install/binary.ts` (+ `sonarsource-releases.ts`,
  `install-utils.ts`, `install-types.ts`) — generic download → verify → install
  pipeline already used for other Sonar dependency binaries (`sonar-secrets`,
  `sca-scanner-cli`, `sonar-context-augmentation`). Structurally the right model
  to follow (`ensureBinDirectory`, `makeExecutable`, `verifyInstallation`,
  `cleanupOldVersionBinaries`), **but** it verifies via public-key signature
  (`verifyBinarySignature`), whereas the CLI's own MDM/user-scripts artifacts are
  currently verified via a plain `.sha256` sidecar file. Don't silently switch
  the CLI's own verification scheme as a side effect of this refactor — flag it
  as a separate decision if it comes up.
- `src/core/host/environment/platform-detector.ts` — `detectPlatform()` /
  `isWindows()`, reuse rather than re-detecting `uname -m` equivalents by hand.
- `src/core/update/check.ts` — `fetchLatestVersion()` (reads `stable.version`),
  `fetchText()`. Reuse for the "no approved-version override" fallback path.
- `src/core/version.ts` — `Version`, `isNewerVersion()`, `stripBuildNumber()` —
  reuse for the semver comparison `update` needs for its skip-if-current-check.
- `src/core/config-constants.ts` — `SONARSOURCE_BINARIES_URL` (already overridable
  via `process.env.SONARQUBE_CLI_BINARIES_URL`), `CLI_STABLE_VERSION_PATH`. The
  CDN-mirror requirement below should plug into/extend this existing override
  point rather than inventing a parallel one.
- `src/core/host/distribution.ts` — `CURRENT_DISTRIBUTION` /
  `DISTRIBUTIONS` / `enableSelfUpdate`. Currently only one distribution
  (`standalone`) exists, and `sonar update`'s registration in
  `command-tree.ts` is gated on `CURRENT_DISTRIBUTION.enableSelfUpdate`. Decide
  (open question below) whether `sonar mdm *` needs its own capability flag here
  or should just always be registered regardless of distribution.
- `src/commands/command-tree.ts` — registration pattern for top-level command
  groups with subcommands (`COMMAND_TREE.command('update')...`, then
  `updateCommand.command('status')...`). Mirror this for `sonar mdm install
  | update | rollback | remove`.

## Target architecture

```
JumpCloud "install" command (bash, mac+linux; separate tiny .ps1 for windows)
  → resolve version (approved-version override, else stable.version)
  → download versioned artifact + .sha256 sidecar, verify
  → chmod +x
  → exec <tmp-path> mdm install [--approved-version X] [--cdn-url Y]
       (the already-downloaded, already-verified temp binary IS the install source —
        it copies itself, it does not re-download)

JumpCloud "update" / "rollback" / "remove" commands
  → literally: sonar mdm update [--approved-version X] [--force] [--cdn-url Y]
              sonar mdm rollback --version X [--cdn-url Y]
              sonar mdm remove
     (no bootstrap needed — sonar is already installed and trusted;
      update/rollback do their own download+verify of the NEW version internally)
```

Only `install` needs an external bootstrap loader, because JumpCloud has no way
to execute TS code directly and there is no trusted binary yet to invoke. Every
other action is a one-line invocation of the already-installed binary.

## New CLI surface: `sonar mdm <action>`

Add a new top-level command group, structurally mirroring `sonar update` in
`command-tree.ts`. All four subcommands are Unix+Windows aware internally
(`process.platform` branches in shared TS, not separate files per OS).

### `sonar mdm install`

Options:
- `--approved-version <version>` (optional) — pins the version instead of
  fetching `stable.version`. Same validation as today
  (`^[0-9][0-9.]*$` or equivalent semver check via `Version`).
- `--cdn-url <url>` (optional) — overrides the artifact base URL (see CDN
  mirror section below). Not used by `install` for version/download — those
  already happened in the bootstrap — but needed if `install` itself ever
  needs to re-derive URLs (e.g. logging, or if the design changes so install
  also does its own download — see open question).

Behavior (assumes it is invoked from an already-downloaded, already
SHA256-verified temp binary — see bootstrap section):
1. Resolve the canonical install path for the current platform
   (`/usr/local/bin/sonar`, `C:\Program Files\sonarqube-cli\bin\sonar.exe`).
2. Copy itself (`process.execPath`, verify this resolves correctly for a
   Bun-compiled `--compile` binary before relying on it) to that path,
   creating parent directories as needed.
3. `chmod +x` on Unix; on Windows, grant `Authenticated Users:(RX)` (port the
   existing `icacls` invocation, or find/use a Node-native ACL equivalent —
   shelling out to `icacls` via `child_process` is an acceptable, simple port).
4. Windows only: add the install directory to the machine `PATH` (port the
   `[Environment]::SetEnvironmentVariable(..., 'Machine')` +
   `SendMessageTimeout` broadcast — this can be done from Node via the `win32`
   registry APIs or by shelling out to `setx`/`reg.exe`/a short embedded
   PowerShell one-liner; pick whichever keeps this simplest, it's an
   implementation detail, not a design decision).
5. Enumerate local user home directories (port `dscl`/`getent` calls via
   `child_process`, or on Windows just `fs.readdirSync('C:\\Users')` — no need
   to shell out to `Get-ChildItem` for that part). For each user with an
   existing standalone install path, replace it with a symlink to the
   canonical binary (same logic/paths as today).

### `sonar mdm update`

Options:
- `--approved-version <version>` (optional) — same semantics as install.
- `--force` (optional) — same semantics as today's `SONARQUBE_CLI_FORCE`.
- `--cdn-url <url>` (optional).

Behavior:
1. Resolve target version (approved-version override, else `stable.version`
   via `fetchLatestVersion()`).
2. If already installed: compare installed vs. target semver (reuse
   `Version`/`isNewerVersion`); skip with a clear message unless `--force`.
3. Download the target artifact + verify SHA256 (same as install's bootstrap
   logic, but now done **inside** the TS code, since there's no separate
   bootstrap for this action) to a temp location.
4. **Self-replace the canonical binary while it may be the one currently
   running.** This is the one genuinely new piece of engineering — see
   "Windows self-replace" section below. On Unix, an atomic rename/move over
   the target path is enough (doesn't affect an already-open running file).
5. Does not touch PATH or re-run the per-user symlink step (matches today's
   `update.sh`/`update.ps1` — only `install` does that).

### `sonar mdm rollback`

Options:
- `--version <version>` (**required** — no default, matches today's required
  `SONARQUBE_CLI_ROLLBACK_VERSION`).
- `--cdn-url <url>` (optional).

Behavior: same as `update` minus the "already at version" skip check and minus
`--force` (today's rollback always re-downloads and replaces unconditionally).

### `sonar mdm remove`

No options.

Behavior:
1. Delete the canonical binary. On Unix this is a plain `unlink()` of the
   currently-running file (safe — the process keeps running from the deleted
   inode until it exits). On Windows this needs the same self-delete handling
   as the update path — see below.
2. Loop: while `sonar` resolves on `PATH`, sanity-check its `--version` output
   looks like the real CLI, then delete it — repeat until nothing resolves
   (port the existing loop as-is).
3. Enumerate local users and delete their standalone install path if present
   (same enumeration as install).
4. Note (carry forward, don't silently fix): today's scripts don't revert the
   Windows PATH edit made by `install`. Decide explicitly whether `mdm remove`
   should now do so — flagged as an open question below, not assumed.

## Variable → flag mapping

| Today (JumpCloud Custom Variable, textually substituted into the script) | Becomes (CLI flag, passed as a real argument in the one-line JumpCloud command) | Used by |
|---|---|---|
| `SONARQUBE_CLI_APPROVED_VERSION` | `--approved-version <version>` | install, update |
| `SONARQUBE_CLI_FORCE` | `--force` | update |
| `SONARQUBE_CLI_ROLLBACK_VERSION` | `--version <version>` (required) | rollback |
| *(new — does not exist today)* | `--cdn-url <url>` | install (bootstrap only), update, rollback |

The last row is new: some customers want to mirror `binaries.sonarsource.com`
rather than fetch directly from it. Note the codebase already has a precedent
for this exact kind of override — `SONARSOURCE_BINARIES_URL` in
`config-constants.ts` already reads `process.env.SONARQUBE_CLI_BINARIES_URL`.
`--cdn-url` should feed into that same resolution point (e.g. by setting the
env var before the rest of the code path runs, or by threading the value
explicitly into whichever download helper is used) rather than introducing a
second, parallel base-URL concept.

All four subcommands still need the same defensive format validation the shell
scripts do today (a version string can't contain quotes/`$()`/backticks) —
even though CLI argument parsing isn't vulnerable to shell-injection the way
`{{VAR}}` textual substitution was, keep the validation for basic
correctness/fail-fast, using this codebase's existing pattern (commander +
`InvalidArgumentError`, see `parseInteger` in `src/core/commands/parsing.ts`
for the idiom).

## Bootstrap loader (the only shell/PowerShell code that remains)

Two files replace the 8 `install`/`update`/`rollback`/`remove` × macOS/Linux
scripts plus 4 Windows ones that exist today — but only for **install**; the
other three actions need no bootstrap at all (see architecture diagram above):

- `mdm-scripts/direct-sonar-cdn/install-bootstrap.sh` — one file covering both
  macOS and Linux (mirror the `detect_os`/`detect_platform` branching already
  used in `user-scripts/install.sh`).
- `mdm-scripts/direct-sonar-cdn/install-bootstrap.ps1` — Windows.

Each does only: parse the two passed-through values (approved version, CDN
base URL) from its own JumpCloud Custom Variables, resolve platform+arch,
resolve target version (approved-version override or `stable.version` from
the resolved base URL), download the artifact + `.sha256` sidecar, verify,
`chmod +x` (Unix), then exec `<tmp-path> mdm install --approved-version
<resolved-version> --cdn-url <base-url>` (pass the *resolved* version through
explicitly, so `mdm install` doesn't need its own network round-trip to
`stable.version` — it already knows exactly what it's installing). Clean up
the temp file afterward.

This is intentionally almost the same code the current `verify_sha256`/
`download_binary` functions already contain — it's a trim-down, not a
rewrite: delete everything after "download and verify" (the PATH editing,
`icacls`, user-enumeration, symlinking) since that all moved into `mdm
install`.

## Windows self-replace / self-delete — new engineering, not a port

This is the one part of this spec that isn't "move existing logic into TS" —
it doesn't exist anywhere in this codebase yet in headless form.

**The problem:** Windows locks a running `.exe`'s file — you cannot overwrite
it in place, and (unlike Unix) you generally cannot even delete/rename a
running process's own backing file without help. The existing `sonar update`
command sidesteps this by spawning a **visible new PowerShell window** and
exiting — acceptable for an interactive user, not for a JumpCloud policy run
with no desktop session.

**Required approach (headless):** rename-and-replace, in the same shape as
the Rust `self_replace` crate (used by e.g. `uv self update`) or Squirrel's
`Update.exe`:
1. Rename the currently-running `sonar.exe` aside (Windows allows renaming an
   open/running file, just not deleting or overwriting it in place).
2. Move the new, already-verified binary into the now-free canonical path.
3. Arrange for the renamed-aside old file to be deleted once the current
   process exits — e.g. spawn a short-lived detached helper process that waits
   for the parent PID to exit then deletes the renamed file, or open a handle
   with delete-on-close semantics before spawning. Consult the `self_replace`
   crate's approach and uv's PR history
   (`astral-sh/uv#20855`, staged-update fix) for the exact sequencing that
   avoids leaving the install broken if interrupted mid-way — the important
   property to preserve is: **the old, still-working binary must remain in
   place and functional until the new one is fully staged and verified**, only
   the final swap should be the risky step.

For `mdm remove` on Windows, the same rename-based approach applies, just
without a replacement binary — rename aside then arrange for deletion after
exit (or delete on next boot via `MOVEFILE_DELAY_UNTIL_REBOOT` if a delayed,
guaranteed-eventually cleanup is acceptable — note this leaves a stale file
until the next reboot, flag as a tradeoff to decide explicitly, not silently
picked).

Decision: the delayed delete is used for both `update` and `remove`. A detached
helper that waits for the parent was implemented first, but it never ran under
Bun `--compile` on the Windows CI runner. The renamed `.old` therefore stays on
disk until the next reboot; stale `.old` files are swept by the next
`update`/`rollback`/`remove`.

Land this as its own small module (e.g. `src/core/host/self-replace.ts`) with
a Unix branch (trivial: rename/unlink) and a Windows branch (the above),
rather than inlining it into the `mdm update`/`mdm rollback`/`mdm remove`
command handlers — `update` and `rollback` both need "replace the running
binary," so it should be one shared function, not two copies.

## Acceptance criteria (behavioral parity checklist)

For each item, the new `sonar mdm <action>` must do what the corresponding
existing script does, unless a design decision (below) explicitly changes it:

- [ ] install: approved-version override validated and respected; else fetches
      `stable.version` (via the resolved CDN base URL).
- [ ] install: downloads `.bin`, falls back to `.exe` if `.bin` 404s (confirm
      whether this fallback is still needed — check current release artifacts
      before deciding to drop it).
- [ ] install: SHA256-verifies against the `.sha256` sidecar; aborts on
      mismatch or on failure to fetch the expected hash.
- [ ] install: sets executable bit; strips `com.apple.quarantine` on macOS.
- [ ] install: places binary at the correct canonical path per OS.
- [ ] install (Windows only): grants `Authenticated Users:(RX)`; adds install
      dir to machine `PATH`; broadcasts the environment-change notification.
- [ ] install: enumerates local users and symlinks each one's standalone path
      to the canonical binary, skipping ones already correctly symlinked.
- [ ] update: skips if already at target version, unless `--force`.
- [ ] update: does NOT touch PATH or per-user symlinks (matches today).
- [ ] update: self-replaces the running canonical binary correctly on both
      Unix and Windows, headless (no visible window, no interactive session
      assumed).
- [ ] rollback: requires an explicit version, always replaces unconditionally.
- [ ] remove: deletes canonical binary; loops removing any further `sonar` on
      `PATH` while sanity-checking `--version` output first; deletes per-user
      standalone installs.
- [ ] remove: works headlessly on Windows (self-delete of a running exe).
- [ ] `--cdn-url` override actually changes where artifacts/checksums/
      `stable.version` are fetched from, for install/update/rollback.

## Open questions (resolve before/while implementing, don't guess silently)

1. **Command gating**: should `sonar mdm *` be registered unconditionally, or
   gated behind something in `distribution.ts` (today only `standalone`
   exists; `sonar update`'s registration is gated on
   `CURRENT_DISTRIBUTION.enableSelfUpdate`)? These are lifecycle commands for
   managing the CLI itself regardless of how *this particular* binary was
   installed, so unconditional registration is the more likely answer — but
   confirm rather than assume.
2. **`.exe` fallback**: still needed, or is `.bin` now always published? Check
   current release artifacts on `binaries.sonarsource.com` before deciding.
3. **`mdm remove` and the Windows PATH edit**: today's `remove.ps1` does not
   revert the machine PATH change `install.ps1` made. Decide explicitly
   whether the new `mdm remove` should now clean this up (behavior change) or
   intentionally preserve today's behavior (leaves a dangling PATH entry).
4. **`--cdn-url` wiring**: confirm whether it should set
   `process.env.SONARQUBE_CLI_BINARIES_URL` for the duration of the command
   (reusing the existing override point everywhere it's read) or be threaded
   explicitly through a narrower download helper — the former is simpler but
   has global side effects for the process lifetime; the latter is more
   contained but touches more call sites.
5. **`process.execPath` reliability**: verify empirically (in a Bun
   `--compile` build, on all three OSes) that it points at the real
   currently-running binary path before `mdm install` relies on it to copy
   itself.
6. **Where `sonar mdm rollback`/`update`'s own download+verify logic lives**:
   should it reuse/extend `core/host/install/binary.ts`'s generic pipeline
   (adapted for self-replace of a running process, and for SHA256-file
   verification instead of that module's signature-based verification), or
   be its own small, separate module given the semantic difference
   (installing a *dependency* binary vs. replacing *the running process's
   own* binary)? Recommend evaluating both, but don't block the rest of the
   implementation on this — it's an internal code-organization choice, not a
   behavior one.
