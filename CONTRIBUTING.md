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

- [Bun](https://bun.sh/) 1.3.9+ — required for running tests and building binaries

## Setup

```bash
bun install
```

## Building

The supported build is a self-contained standalone executable:

```bash
bun run build:binary
```

Produces `dist/sonarqube-cli` using Bun's single-file compiler. To use it locally, add `dist/` to your `PATH` or symlink `dist/sonarqube-cli` somewhere on your `PATH` (e.g. `ln -s "$PWD/dist/sonarqube-cli" ~/.local/bin/sonar`).

## Checks

Run these to validate your local build:

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

# Integration tests (compiled binary against fake servers)
bun run test:integration

# Unit + integration
bun run test:all

# End-to-end tests (verifies full integration with external systems)
bun run test:e2e

# Full merged lcov report (unit + integration, slow)
bun run test:coverage
```

### Integration tests

Integration tests run the compiled binary in isolated temporary environments with fake servers and a fake keychain. `bun run test:integration` performs the build/resource setup automatically. To iterate on one spec, run `bun run pretest:integration` once, then `bun test <file>`.

E2E tests exercise external systems where required. Follow each suite's prerequisites and environment-variable skip behavior. Read [test guidance](tests/AGENTS.md), including telemetry isolation, before adding tests.

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

The docs site outputs (`commands.json`, `llms.txt`, `sitemap.xml`) are generated from CLI source by post-release automation. Do not edit them by hand or regenerate them for routine command changes. When changing the generator itself, use `bun run gen:docs` for local validation and inspect the output without committing unrelated release-generated changes. See [docs guidance](docs/AGENTS.md).

## Agent instructions

Follow [the instruction maintenance policy](docs/development/agent-instructions.md). Ordinary feature work does not require instruction updates; change guidance when it becomes incorrect, a durable convention changes, or a demonstrated recurring mistake needs addressing. Engineering rules live in `AGENTS.md` and its routed scoped sources; use clients' native support instead of adding duplicate instruction files.
