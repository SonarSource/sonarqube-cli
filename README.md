# SonarQube CLI

[![Build](https://github.com/SonarSource/sonarqube-cli/actions/workflows/build.yml/badge.svg?branch=master)](https://github.com/SonarSource/sonarqube-cli/actions/workflows/build.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=SonarSource_sonarqube-cli&metric=alert_status&token=4ad890bd54c6c3feb5d5251004fa3e5b1f665dea)](https://sonarcloud.io/summary/new_code?id=SonarSource_sonarqube-cli)

A CLI application for interacting with SonarQube products. This product is currently in open Beta, and we are actively collecting feedback on it. Please share your thoughts via [this form](https://forms.gle/xE61HS2E5NzxFCSR9)!

## Installation

**Linux/Mac OS:**

```bash
curl -o- https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts/install.sh | bash
```

**Windows (from PowerShell):**

```powershell
irm https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts/install.ps1 | iex
```

## Setup steps for Claude Code integration
Below is an example of a setup which will work for SonarQube Cloud.
The authentification step is optional. Without authentification secrets will still work but will check fewer rules.
#### `sonar auth login`
#### `sonar install secrets`
#### `sonar integrate claude -g`

## Commands

### `sonar auth`

Manage authentication tokens and credentials

#### `sonar auth login`

Save authentication token to keychain

**Options:**

| Option               | Type   | Required | Description                                                     | Default |
| -------------------- | ------ | -------- | --------------------------------------------------------------- | ------- |
| `--server`, `-s`     | string | No       | SonarQube URL (default is SonarQube https://sonarcloud.io)      | -       |
| `--org`, `-o`        | string | No       | SonarQube Cloud organization key (required for SonarQube Cloud) | -       |
| `--with-token`, `-t` | string | No       | Token value (skips browser, non-interactive mode)               | -       |

**Examples:**

Interactive login for SonarQube Cloud with browser
```bash
sonar auth login
```

Non-interactive login with direct token
```bash
sonar auth login -o my-org -t squ_abc123
```

Non-interactive login for custom server with token
```bash
sonar auth login -s https://my-sonarqube.io --with-token squ_def456
```

---

#### `sonar auth logout`

Remove authentication token from keychain

**Options:**

| Option           | Type   | Required | Description                                                     | Default |
| ---------------- | ------ | -------- | --------------------------------------------------------------- | ------- |
| `--server`, `-s` | string | No       | SonarQube server URL                                            | -       |
| `--org`, `-o`    | string | No       | SonarQube Cloud organization key (required for SonarQube Cloud) | -       |

**Examples:**

Remove token for SonarQube Cloud organization
```bash
sonar auth logout -o my-org
```

Remove token for custom SonarQube server
```bash
sonar auth logout -s https://my-sonarqube.io
```

---

#### `sonar auth purge`

Remove all authentication tokens from keychain

**Examples:**

Interactively remove all saved tokens
```bash
sonar auth purge
```

---

#### `sonar auth status`

Show active authentication connection with token verification

**Examples:**

Show current server connection and token status
```bash
sonar auth status
```

---

### `sonar install`

Install Sonar tools

#### `sonar install secrets`

Install sonar-secrets binary from https://binaries.sonarsource.com

**Options:**

| Option     | Type    | Required | Description                                     | Default |
| ---------- | ------- | -------- | ----------------------------------------------- | ------- |
| `--force`  | boolean | No       | Force reinstall even if already installed       | -       |
| `--status` | boolean | No       | Check installation status instead of installing | -       |

**Examples:**

Install latest sonar-secrets binary
```bash
sonar install secrets
```

Reinstall sonar-secrets (overwrite existing)
```bash
sonar install secrets --force
```

Check if sonar-secrets is installed and up to date
```bash
sonar install secrets --status
```

---

### `sonar integrate`

Setup SonarQube integration for AI coding agents, git and others.

**Examples:**

Integrate Claude Code with interactive setup
```bash
sonar integrate claude -s https://sonarcloud.io -p my-project
```

Integrate without installing hooks
```bash
sonar integrate claude --skip-hooks
```

Integrate globally and install hooks to ~/.claude which will be available for all projects
```bash
sonar integrate claude -g
```

#### `sonar integrate claude`

Setup SonarQube integration for Claude Code. This will install secrets scanning hooks, and configure SonarQube MCP Server.

**Options:**

| Option              | Type    | Required | Description                                                                 | Default |
| ------------------- | ------- | -------- | --------------------------------------------------------------------------- | ------- |
| `--server`, `-s`    | string  | No       | SonarQube server URL                                                        | -       |
| `--project`, `-p`   | string  | No       | Project key                                                                 | -       |
| `--token`, `-t`     | string  | No       | Existing authentication token                                               | -       |
| `--org`, `-o`       | string  | No       | Organization key (for SonarQube Cloud)                                      | -       |
| `--non-interactive` | boolean | No       | Non-interactive mode (no prompts)                                           | -       |
| `--skip-hooks`      | boolean | No       | Skip hooks installation                                                     | -       |
| `--global`, `-g`    | boolean | No       | Install hooks and config globally to ~/.claude instead of project directory | -       |

---

### `sonar list`

List Sonar resources

#### `sonar list issues`

Search for issues in SonarQube

**Options:**

| Option            | Type   | Required | Description        | Default |
| ----------------- | ------ | -------- | ------------------ | ------- |
| `--project`, `-p` | string | Yes      | Project key        | -       |
| `--severity`      | string | No       | Filter by severity | -       |
| `--format`        | string | No       | Output format      | `json`  |
| `--branch`        | string | No       | Branch name        | -       |
| `--pull-request`  | string | No       | Pull request ID    | -       |
| `--page-size`     | number | No       | Page size (1-500)  | `500`   |
| `--page`          | number | No       | Page number        | `1`     |

**Examples:**

List issues in a project
```bash
sonar list issues -p my-project
```

Output issues in TOON format for AI agents
```bash
sonar list issues -p my-project --format toon
```

---

#### `sonar list projects`

Search for projects in SonarQube

**Options:**

| Option          | Type   | Required | Description                                    | Default |
| --------------- | ------ | -------- | ---------------------------------------------- | ------- |
| `--query`, `-q` | string | No       | Search query to filter projects by name or key | -       |
| `--page`        | number | No       | Page number                                    | `1`     |
| `--page-size`   | number | No       | Page size (1-500)                              | `500`   |

**Examples:**

List first 500 accessible projects
```bash
sonar list projects
```

Search projects by name or key
```bash
sonar list projects -q my-project
```

Paginate through projects
```bash
sonar list projects --page 2 --page-size 50
```

---

### `sonar analyze`

Analyze code for security issues

#### `sonar analyze secrets`

Scan a file or stdin for hardcoded secrets

**Options:**

| Option    | Type    | Required | Description                                | Default |
| --------- | ------- | -------- | ------------------------------------------ | ------- |
| `--file`  | string  | No       | File path to scan for secrets              | -       |
| `--stdin` | boolean | No       | Read from standard input instead of a file | -       |

**Examples:**

Scan a file for hardcoded secrets
```bash
sonar analyze secrets --file src/config.ts
```

Scan stdin for hardcoded secrets
```bash
cat .env | sonar analyze secrets --stdin
```

---

### `sonar config`

Configure CLI settings

#### `sonar config telemetry`

Configure telemetry settings

**Options:**

| Option       | Type    | Required | Description                                      | Default |
| ------------ | ------- | -------- | ------------------------------------------------ | ------- |
| `--enabled`  | boolean | No       | Enable collection of anonymous usage statistics  | -       |
| `--disabled` | boolean | No       | Disable collection of anonymous usage statistics | -       |

**Examples:**

Enable collection of anonymous usage statistics
```bash
sonar config telemetry --enabled
```

Disable collection of anonymous usage statistics
```bash
sonar config telemetry --disabled
```

---

## Option Types

- `string` — text value (e.g. `--server https://sonarcloud.io`)
- `boolean` — flag (e.g. `--verbose`)
- `number` — numeric value (e.g. `--page-size 100`)
- `array` — multiple values (e.g. `--tags tag1 tag2`)

## Exit Codes

| Code | Meaning                           |
|------|-----------------------------------|
| 0    | Success                           |
| 1    | Error (validation, execution, etc.) |

---

## State Management

See [State Management](./docs/state-management.md) for more information.

## Contributing

Please be aware that we are not actively looking for feature contributions. The truth is that it's extremely difficult for someone outside
SonarSource to comply with our roadmap and expectations. Therefore, we typically only accept minor cosmetic changes and typo fixes.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup instructions, coding guidelines, and how to run tests.

## License

Copyright 2026 SonarSource Sàrl.

SonarQube CLI is released under the [GNU Lesser General Public License, Version 3.0⁠,](http://www.gnu.org/licenses/lgpl.txt).

*Generated from `src/cli/command-tree.ts` — do not edit manually*
