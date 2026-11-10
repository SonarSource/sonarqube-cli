# Standalone installers

- Stable installers resolve the actual release from `Distribution/sonarqube-cli/stable.version`. Preserve the literal compatibility version marker for older `sonar self-update` clients; the release workflow advances it after publication.
- Shell installers map `aarch64`/`arm64` to `linux-arm64` and `x86_64`/`amd64` to `linux-x86-64`. Retain unsupported-platform handling.
- CLI Linux/macOS downloads try `.bin` then historical `.exe`; Windows uses `.exe`. Do not apply this fallback to unrelated dependency binaries.
- All stable and prerelease installers show PATH setup instructions only when the install directory is absent from the current process PATH. Completion and installation location remain visible after every successful installation.
- Preserve the per-user install destination used by self-update ownership checks. Read [update guidance](../src/core/update/AGENTS.md) before changing paths or update behavior and [build guidance](../build-scripts/AGENTS.md) before changing artifact publication.
- Installer tests exercise real binaries/network where required. Read [test guidance](../tests/AGENTS.md), including subprocess telemetry isolation, before adding invocations.
