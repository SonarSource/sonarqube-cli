# sonar - CLI Documentation

SonarQube CLI for Claude Code integration

**Version:** 0.0.1
**Generated:** 2026-02-09T00:00:00.000Z

---

## Commands

### `sonar auth`

Manage authentication tokens and credentials

#### Subcommands:

##### `sonar auth login`

Save authentication token to keychain

**Options:**

| Option | Type | Required | Description | Default |
|--------|------|----------|-------------|---------|
| `--server`, `-s` | string | ❌ | SonarQube server URL (default is SonarCloud) | - |
| `--org`, `-o` | string | ❌ | SonarCloud organization key (required for SonarCloud) | - |
| `--with-token`, `-t` | string | ❌ | Token value (skips browser, non-interactive mode) | - |

**Examples:**

```bash
sonar auth login
```
Interactive login for SonarCloud with browser

```bash
sonar auth login -o my-org
```
Interactive login for specific SonarCloud organization

```bash
sonar auth login -s https://my-sonarqube.io
```
Interactive login for custom SonarQube server

```bash
sonar auth login -o my-org -t squ_abc123
```
Non-interactive login with direct token

```bash
sonar auth login -s https://my-sonarqube.io --with-token squ_def456
```
Non-interactive login for custom server with token

---

##### `sonar auth logout`

Remove authentication token from keychain

**Options:**

| Option | Type | Required | Description | Default |
|--------|------|----------|-------------|---------|
| `--server`, `-s` | string | ❌ | SonarQube server URL | - |
| `--org`, `-o` | string | ❌ | SonarCloud organization key (required for SonarCloud) | - |

**Examples:**

```bash
sonar auth logout -o my-org
```
Remove token for SonarCloud organization

```bash
sonar auth logout -s https://my-sonarqube.io
```
Remove token for custom SonarQube server

---

##### `sonar auth purge`

Remove all authentication tokens from keychain

**Examples:**

```bash
sonar auth purge
```
Interactively remove all saved tokens

---

### `sonar issues`

Manage SonarQube issues

#### Subcommands:

##### `sonar issues search`

Search for issues in SonarQube

**Options:**

| Option | Type | Required | Description | Default |
|--------|------|----------|-------------|---------|
| `--server`, `-s` | string | ✅ | SonarQube server URL | - |
| `--token`, `-t` | string | ❌ | Authentication token | - |
| `--project`, `-p` | string | ✅ | Project key | - |
| `--severity` | string | ❌ | Filter by severity (INFO, MINOR, MAJOR, CRITICAL, BLOCKER) | - |
| `--format` | string | ❌ | Output format (json, toon, table, csv) | `json` |
| `--branch` | string | ❌ | Branch name | - |
| `--pull-request` | string | ❌ | Pull request ID | - |
| `--all` | boolean | ❌ | Fetch all issues with pagination | - |
| `--page-size` | number | ❌ | Page size for pagination | `500` |

**Examples:**

```bash
sonar issues search -s https://sonarcloud.io -p my-project -t TOKEN
```
Search issues in a project

```bash
sonar issues search -s https://sonarcloud.io -p my-project --format toon
```
Output issues in TOON format for AI agents

```bash
sonar issues search -s https://sonarcloud.io -p my-project --severity CRITICAL --all
```
Fetch all critical issues

---

### `sonar onboard-agent`

Setup SonarQube integration for Claude Code

**Arguments:**

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `agent` | string | ✅ | Agent name (only 'claude' is currently supported) |

**Options:**

| Option | Type | Required | Description | Default |
|--------|------|----------|-------------|---------|
| `--server`, `-s` | string | ❌ | SonarQube server URL | - |
| `--project`, `-p` | string | ❌ | Project key | - |
| `--token`, `-t` | string | ❌ | Existing authentication token | - |
| `--org`, `-o` | string | ❌ | Organization key (for SonarCloud) | - |
| `--non-interactive` | boolean | ❌ | Non-interactive mode (no prompts) | - |
| `--skip-hooks` | boolean | ❌ | Skip hooks installation | - |
| `--hook-type` | string | ❌ | Hook type to install (prompt, cli) | `prompt` |
| `--verbose`, `-v` | boolean | ❌ | Verbose output | - |

**Examples:**

```bash
sonar onboard-agent claude -s https://sonarcloud.io -p my-project
```
Setup Claude Code integration with interactive prompts

```bash
sonar onboard-agent claude -s https://sonarcloud.io -p my-project -t TOKEN --non-interactive
```
Non-interactive setup for Claude Code with token

```bash
sonar onboard-agent claude --skip-hooks -v
```
Setup without installing hooks (verbose mode)

---

## Global Options

| Option | Description |
|--------|-------------|
| `-V, --version` | Output version number |
| `-h, --help` | Display help for command |

---

## Option Types

- `string` - Text value (e.g., `--server https://sonarcloud.io`)
- `boolean` - Flag (e.g., `--verbose`)
- `number` - Numeric value (e.g., `--page-size 100`)

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (validation, execution, etc.) |

---

## Supported Agents

Currently, only **Claude Code** is supported for integration setup.

Future support: Gemini, Codex (coming soon)

---

*Documentation reflects CLI specification. For source code, see cli-spec.yaml*
