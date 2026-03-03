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
```

## Testing

```bash
# Unit tests
bun test

# Unit tests with coverage
bun run test:coverage

# Script tests
bun run test:scripts

# Integration tests (require env vars — see below)
bun run test:integration

# All tests
bun run test:all
```

### Integration tests

Integration tests hit real external services and require environment variables:

```bash
export SONAR_SECRETS_TOKEN="sqp_xxxxx"   # SonarQube token for secret scanning
export SONAR_SECRETS_AUTH_URL="https://sonarcloud.io"       # SonarQube token for onboard-agent tests
```

Obtain a token from **sonarcloud.io → Account → Security → Generate token**.

If the variables are not set, the relevant tests are skipped automatically — this is expected for local development.

## Doc generation

The README.md file is generated from the source code. When adding or modifying a command, please call:

```bash
bun run gen:docs
```
