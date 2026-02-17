# sonar - CLI Documentation

SonarQube CLI for AI coding agents

**Version:** 0.2.97
**Generated:** 2026-02-17T10:57:12.343Z

---

## Commands

### `sonar verify`

Analyze a file using SonarCloud A3S API

**Options:**

| Option | Type | Required | Description | Default |
|--------|------|----------|-------------|---------|
| `--file` | string | ✅ | File path to analyze | - |
| `--organization` | string | ❌ | Organization key (or use saved config) | - |
| `--project` | string | ❌ | Project key | - |
| `--token`, `-t` | string | ❌ | Authentication token (or use saved config) | - |
| `--branch`, `-b` | string | ❌ | Branch name | - |
| `--save-config` | boolean | ❌ | Save configuration for future use | - |

**Examples:**

```bash
sonar verify src/MyClass.java
```
Analyze a single Java file

```bash
sonar verify --file src/MyClass.java --organization sonarsource --project my-project -t TOKEN --save-config
```
Analyze a file and save config for future use

```bash
sonar verify --file src/MyClass.java
```
Analyze using saved configuration

```bash
sonar verify --file src/MyClass.java --branch main
```
Analyze file on a specific branch


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
| `--severity` | string | ❌ | Filter by severity | - |
| `--format` | string | ❌ | Output format | `json` |
| `--branch` | string | ❌ | Branch name | - |
| `--pull-request` | string | ❌ | Pull request ID | - |
| `--all` | boolean | ❌ | Fetch all issues with pagination | `false` |
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

Setup SonarQube integration for AI coding agent

**Options:**

| Option | Type | Required | Description | Default |
|--------|------|----------|-------------|---------|
| `--server`, `-s` | string | ❌ | SonarQube server URL | - |
| `--project`, `-p` | string | ❌ | Project key | - |
| `--token`, `-t` | string | ❌ | Existing authentication token | - |
| `--org`, `-o` | string | ❌ | Organization key (for SonarCloud) | - |
| `--non-interactive` | boolean | ❌ | Non-interactive mode (no prompts) | - |
| `--skip-hooks` | boolean | ❌ | Skip hooks installation | - |
| `--hook-type` | string | ❌ | Hook type to install | `prompt` |
| `--verbose`, `-v` | boolean | ❌ | Verbose output | - |

**Examples:**

```bash
sonar onboard-agent claude -s https://sonarcloud.io -p my-project
```
Onboard Claude Code with interactive setup

```bash
sonar onboard-agent gemini -s https://sonarcloud.io -p my-project -t TOKEN --non-interactive
```
Non-interactive onboarding for Gemini (not yet supported)

```bash
sonar onboard-agent claude --skip-hooks -v
```
Onboard without installing hooks (verbose mode)


---

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

##### `sonar auth purge`

Remove all authentication tokens from keychain

**Examples:**

```bash
sonar auth purge
```
Interactively remove all saved tokens

##### `sonar auth list`

List saved authentication connections with token verification

**Examples:**

```bash
sonar auth list
```
Show all saved authentication connections


---

### `sonar pre-commit`

Manage pre-commit hooks for secrets detection


#### Subcommands:

##### `sonar pre-commit install`

Install Sonar secrets pre-commit hook

**Examples:**

```bash
sonar pre-commit install
```
Install pre-commit and configure SonarSource secrets hook

##### `sonar pre-commit uninstall`

Uninstall Sonar secrets pre-commit hook

**Examples:**

```bash
sonar pre-commit uninstall
```
Remove pre-commit hook and configuration file


---

### `sonar secret`

Manage sonar-secrets binary


#### Subcommands:

##### `sonar secret install`

Install sonar-secrets binary from GitHub releases

**Options:**

| Option | Type | Required | Description | Default |
|--------|------|----------|-------------|---------|
| `--force` | boolean | ❌ | Force reinstall even if already installed | - |

**Examples:**

```bash
sonar secret install
```
Install latest sonar-secrets binary

```bash
sonar secret install --force
```
Reinstall sonar-secrets (overwrite existing)

##### `sonar secret status`

Check sonar-secrets installation status

**Examples:**

```bash
sonar secret status
```
Check if sonar-secrets is installed and up to date


---


## Option Types

- `string` - Text value (e.g., `--server https://sonarcloud.io`)
- `boolean` - Flag (e.g., `--verbose`)
- `number` - Numeric value (e.g., `--page-size 100`)
- `array` - Multiple values (e.g., `--tags tag1 tag2`)

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (validation, execution, etc.) |

---

*This documentation was auto-generated from `cli-spec.yaml`*
