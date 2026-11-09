# Contributing to sonarqube-cli

> **We don't accept external pull requests on this project.** Keeping all changes in one
> place lets us properly track, plan, prioritize, and test everything that goes into the
> CLI. If you've found a bug or have an idea, please
> [open a GitHub Issue](https://github.com/SonarSource/sonarqube-cli/issues/new/choose)
> instead — we'd love to hear from you.
>
> The source is public, so you're welcome to fork it, read it, and experiment. The rest
> of this guide explains how to build and run the CLI from source.

## Prerequisites

- [mise](https://mise.jdx.dev/getting-started.html) — install it and activate it in your shell.
- [Bun](https://bun.sh/) — use the version pinned in `mise.toml`. The setup below installs it.

## Setup

From the repository root, install the pinned toolchain and dependencies:

```bash
mise trust
mise install
bun install --frozen-lockfile
```

## Building

The supported distribution is a standalone executable. There is no npm distribution build.

To run the CLI from source during development:

```bash
bun run dev --help
```

### Self-contained binary

```bash
bun run build:binary
```

Produces `dist/sonarqube-cli` using Bun's single-file compiler. To use it locally, add `dist/` to your `PATH` or symlink `dist/sonarqube-cli` somewhere on your `PATH` (e.g. `ln -s "$PWD/dist/sonarqube-cli" ~/.local/bin/sonar`).

## Checks

Run these to validate your local build:

```bash
# Check formatting
bun run format:check

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

# Integration tests (isolated harness; setup runs automatically)
bun run test:integration

# Unit + integration
bun run test:all

# End-to-end tests (verifies full integration with external systems)
bun run test:e2e

# Full merged lcov report (unit + integration, slow)
bun run test:coverage
```

### Integration tests

Integration tests run the compiled binary against fake servers in isolated temporary environments. They do not require real SonarQube Server or Cloud tokens.

`bun run test:integration` automatically runs `pretest:integration` to build the binary and prepare test resources. To run one integration test file, prepare the resources first:

```bash
bun run pretest:integration
bun test tests/integration/specs/<command>/<file>.test.ts
```

Repeat the setup after changes to the CLI source or test resources.

### End-to-end tests

Run `bun run pretest:integration` before `bun run test:e2e` to build the CLI and prepare the shared binary fixtures.

E2E tests cover dependencies that the isolated integration harness does not replace. Requirements vary by suite: OS keychain access, network access for installers and binary downloads, real SonarQube services, or external tools. Check the relevant tests under `tests/e2e/` before running them. Suites can skip tests when their prerequisites are unavailable; a skipped test does not validate that behavior.

The context E2E suites use real context-augmentation binaries and fake servers. They need access to `binaries.sonarsource.com`, but no real SonarQube Server or Cloud account. See [the test guide](tests/AGENTS.md) for harness and coverage details.

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
4. In **Keychain Access**, find the private key named _Developer ID Application: SonarSource Sarl_, open **Get Info → Access Control**, and select **Allow all applications to access this item**.

After this, every build signs the binary automatically. On machines without the certificate or without `APPLE_TEAM_ID` set the step is silently skipped.

## Doc generation

The docs site under `docs/` (`commands.json`, `llms.txt`, `sitemap.xml`) is generated from the source code. When adding or modifying a command, regenerate it with:

```bash
bun run gen:docs
```
