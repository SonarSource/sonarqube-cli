# Contributing to sonarqube-cli

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
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

Produces `dist/sonarqube-cli` using Bun's single-file compiler. To install it locally:

```bash
bun run setup
```

## Checks

Run these before opening a pull request:

```bash
# Lint (ESLint + TypeScript-aware rules)
bun run lint

# Auto-fix safe lint issues
bun run lint:fix

# TypeScript type checking
bun run typecheck

# Validate spec.yaml and command registration
bun run validate
```

## Testing

```bash
# Unit tests
bun test

# Unit tests with coverage
bun run test:coverage

# Script tests (validates spec.yaml / command sync)
bun run test:scripts

# Integration tests (require env vars — see below)
bun run test:integration

# All tests
bun run test:all
```

### Integration tests

Integration tests hit real external services and require environment variables:

```bash
export SONAR_SECRETS_TOKEN="sqp_xxxxx"   # SonarCloud token for secret scanning
export SONARCLOUD_TOKEN="sqp_xxxxx"       # SonarCloud token for onboard-agent tests
```

Obtain a token from **sonarcloud.io → Account → Security → Generate token**.

If the variables are not set, the relevant tests are skipped automatically — this is expected for local development.

## Code generation

Commands are generated from `spec.yaml` using Plop:

```bash
# Add a new command interactively
bun run gen:command

# Regenerate docs from spec.yaml
bun run gen:docs

# Sync index.ts command registrations
bun run gen:sync

# Run full generation pipeline
bun run gen:all
```

After editing `spec.yaml` directly, run `bun run validate` to check consistency.
