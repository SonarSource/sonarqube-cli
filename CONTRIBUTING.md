# Contributing to sonarqube-cli

## Prerequisites

- [Bun](https://bun.sh/) 1.3.9+ — required for running tests and building binaries

## Setup

```bash
bun install
```

## Building

### TypeScript build (for npm distribution)

```bash
bun run build
```

Output goes to `dist/`.

### Self-contained binary (for releases)

```bash
bun run build:binary
```

Produces `dist/sonarqube-cli` using Bun's single-file compiler. To use it locally, add `dist/` to your `PATH` or symlink `dist/sonarqube-cli` somewhere on your `PATH` (e.g. `ln -s "$PWD/dist/sonarqube-cli" ~/.local/bin/sonar`).

## Checks

Run these before opening a pull request:

```bash
# Lint (ESLint + TypeScript-aware rules)
bun run lint

# Auto-fix safe lint issues
bun run lint:fix

# TypeScript type checking
bun run typecheck
```

## Testing

```bash
# Unit tests
bun run test:unit

# Integration tests (require env vars — see below)
bun run test:integration

# Unit + integration
bun run test:all

# End-to-end tests (verifies full integration with external systems)
bun run test:e2e

# Full merged lcov report (unit + integration, slow)
bun run test:coverage
```

### Integration tests

Integration tests hit real external services and require environment variables. The CLI targets both **SonarQube Server** and **SonarQube Cloud**, so the token can come from either product:

```bash
export SONAR_SECRETS_TOKEN="sqp_xxxxx"                # SonarQube Server or Cloud token for secret scanning
export SONAR_SECRETS_AUTH_URL="https://sonarcloud.io" # SonarQube Server or Cloud URL for onboard-agent tests
```

Obtain a token from your SonarQube instance: **My Account → Security → Generate token** (SonarQube Cloud at https://sonarcloud.io, or your self-hosted SonarQube Server).

If the variables are not set, the relevant tests are skipped automatically — this is expected for local development.

## macOS code signing (optional)

On macOS, the CLI stores authentication tokens in the system Keychain. macOS ties Keychain ACL entries to the identity of the binary that created them. For unsigned binaries, this identity is derived from the file hash — so every `bun run build:binary` produces a new identity, and macOS will prompt for the Keychain password on the first `sonar` invocation after each rebuild.

To avoid this, install the SonarSource Developer ID certificate locally. Once installed, the post-build hook signs the binary automatically — no prompt on subsequent runs.

### One-time setup

1. Obtain the `certificate.p12` file and the Apple Team ID from Vault (`development/kv/data/sign/sonarqube-cli`).
2. Set the Team ID in your shell profile (e.g. `~/.zshrc`):
   ```bash
   export APPLE_TEAM_ID="<team-id-from-vault>"
   ```
3. Import the certificate into your login Keychain:
   ```bash
   security import certificate.p12 -k ~/Library/Keychains/login.keychain-db
   ```
4. In **Keychain Access**, find the private key named _Developer ID Application: SonarSource SA_, open **Get Info → Access Control**, and select **Allow all applications to access this item**.

After this, every build signs the binary automatically. On machines without the certificate or without `APPLE_TEAM_ID` set the step is silently skipped.

## Doc generation

The README.md file is generated from the source code. When adding or modifying a command, please call:

```bash
bun run gen:docs
```
