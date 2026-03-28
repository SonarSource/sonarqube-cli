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

Produces `dist/sonarqube-cli` using Bun's single-file compiler. Run it directly (for example `./dist/sonarqube-cli --help`). To hack on the CLI without rebuilding the binary, use `bun run dev`, which runs `src/index.ts`.

## Checks

Run these before opening a pull request:

```bash
# Lint (ESLint + TypeScript-aware rules)
bun run lint

# Auto-fix safe lint issues
bun run lint:fix

# TypeScript type checking
bun run typecheck

# Formatting (Prettier)
bun run format:check
```

## Testing

```bash
# Unit tests
bun run test:unit

# Unit tests with coverage (also runs integration with coverage — slower)
bun run test:coverage

# Integration tests (require env vars — see below)
bun run test:integration   # runs pretest:integration first (binary + resources)

# All tests (unit, then integration)
bun run test:all
```

To run a single integration test file with `bun test <path>`, run `bun run pretest:integration` once first so the binary and resources exist. Unit tests can use `bun test <path>` without that step.

### Integration tests

Integration tests hit real external services and require environment variables:

```bash
export SONAR_SECRETS_TOKEN="sqp_xxxxx"   # SonarQube (Server, Cloud) token for secret scanning
export SONAR_SECRETS_AUTH_URL="https://sonarcloud.io"       # SonarQube (Server, Cloud) URL for onboard-agent tests
```

Obtain a token from **sonarcloud.io → Account → Security → Generate token**.

If the variables are not set, the relevant tests are skipped automatically — this is expected for local development.

## Doc generation

The README.md file is generated from the source code. When adding or modifying a command, please call:

```bash
bun run gen:docs
```
