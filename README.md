# SonarQube CLI

A CLI application for interacting with SonarQube products. This product is currently in Open Beta and we are actively collecting feedback on it. Please share your thoughts via [this form](https://forms.gle/xE61HS2E5NzxFCSR9)!

## Installation

**Linux/Mac OS:**

```bash
curl -o- https://gist.githubusercontent.com/kirill-knize-sonarsource/663e7735f883c3b624575f27276a6b79/raw/b9e6add7371f16922a6a7a69d56822906b9e5758/install.sh | bash
```

**Windows (from PowerShell):**

```powershell
irm https://gist.githubusercontent.com/kirill-knize-sonarsource/d75dd5f99228f5a67bcd11ec7d2ed295/raw/a5237e27b0c7bff9a5c7bdeec5fe4b112299b5d8/install.ps1 | iex
```

## Commands

### `sonar auth`

Manage authentication tokens and credentials

#### `sonar auth login`

Save authentication token to keychain

**Options:**

| Option               | Type   | Required | Description                                           | Default |
| -------------------- | ------ | -------- | ----------------------------------------------------- | ------- |
| `--server`, `-s`     | string | No       | SonarQube server URL (default is SonarCloud)          | -       |
| `--org`, `-o`        | string | No       | SonarCloud organization key (required for SonarCloud) | -       |
| `--with-token`, `-t` | string | No       | Token value (skips browser, non-interactive mode)     | -       |

**Examples:**

```bash
sonar auth login
```
Interactive login for SonarCloud with browser

```bash
sonar auth login -o my-org -t squ_abc123
```
Non-interactive login with direct token

```bash
sonar auth login -s https://my-sonarqube.io --with-token squ_def456
```
Non-interactive login for custom server with token

---

#### `sonar auth logout`

Remove authentication token from keychain

**Options:**

| Option           | Type   | Required | Description                                           | Default |
| ---------------- | ------ | -------- | ----------------------------------------------------- | ------- |
| `--server`, `-s` | string | No       | SonarQube server URL                                  | -       |
| `--org`, `-o`    | string | No       | SonarCloud organization key (required for SonarCloud) | -       |

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

#### `sonar auth purge`

Remove all authentication tokens from keychain

**Examples:**

```bash
sonar auth purge
```
Interactively remove all saved tokens

---

#### `sonar auth status`

Show active authentication connection with token verification

**Examples:**

```bash
sonar auth status
```
Show current server connection and token status

---

### `sonar install`

Install Sonar tools

#### `sonar install secrets`

Install sonar-secrets binary from https://binaries.sonarsource.com

**Options:**

| Option     | Type    | Required | Description                                     | Default |
| ---------- | ------- | -------- | ----------------------------------------------- | ------- |
| `--force`  | boolean | No       | Force reinstall even if already installed       | `false` |
| `--status` | boolean | No       | Check installation status instead of installing | `false` |

**Examples:**

```bash
sonar install secrets
```
Install latest sonar-secrets binary

```bash
sonar install secrets --force
```
Reinstall sonar-secrets (overwrite existing)

```bash
sonar install secrets --status
```
Check if sonar-secrets is installed and up to date

---

### `sonar integrate`

Setup SonarQube integration for various tools, like AI coding agents, git and others

**Options:**

| Option              | Type    | Required | Description                       | Default                 |
| ------------------- | ------- | -------- | --------------------------------- | ----------------------- |
| `--server`, `-s`    | string  | No       | SonarQube server URL              | `https://sonarcloud.io` |
| `--project`, `-p`   | string  | No       | Project key                       | -                       |
| `--token`, `-t`     | string  | No       | Existing authentication token     | -                       |
| `--org`, `-o`       | string  | No       | Organization key (for SonarCloud) | -                       |
| `--non-interactive` | boolean | No       | Non-interactive mode (no prompts) | `false`                 |
| `--skip-hooks`      | boolean | No       | Skip hooks installation           | `false`                 |

**Examples:**

```bash
sonar integrate claude -s https://sonarcloud.io -p my-project
```
Integrate Claude Code with interactive setup

```bash
sonar integrate claude --skip-hooks
```
Integrate without installing hooks

---

### `sonar list`

List Sonar resources

#### `sonar list issues`

Search for issues in SonarQube

**Options:**

| Option            | Type    | Required | Description                      | Default |
| ----------------- | ------- | -------- | -------------------------------- | ------- |
| `--server`, `-s`  | string  | No       | SonarQube server URL             | -       |
| `--token`, `-t`   | string  | No       | Authentication token             | -       |
| `--project`, `-p` | string  | Yes      | Project key                      | -       |
| `--severity`      | string  | No       | Filter by severity               | -       |
| `--format`        | string  | No       | Output format                    | `json`  |
| `--branch`        | string  | No       | Branch name                      | -       |
| `--pull-request`  | string  | No       | Pull request ID                  | -       |
| `--all`           | boolean | No       | Fetch all issues with pagination | `false` |
| `--page-size`     | number  | No       | Page size for pagination         | `500`   |

**Examples:**

```bash
sonar list issues -p my-project
```
List issues in a project

```bash
sonar list issues -p my-project --format toon
```
Output issues in TOON format for AI agents

```bash
sonar list issues -p my-project --severity CRITICAL --all
```
Fetch all critical issues

---

#### `sonar list projects`

Search for projects in SonarQube

**Options:**

| Option          | Type   | Required | Description                                    | Default |
| --------------- | ------ | -------- | ---------------------------------------------- | ------- |
| `--query`, `-q` | string | No       | Search query to filter projects by name or key | -       |
| `--page`, `-p`  | number | No       | Page number                                    | `1`     |
| `--page-size`   | number | No       | Page size (1-500)                              | `500`   |

**Examples:**

```bash
sonar list projects
```
List first 500 accessible projects

```bash
sonar list projects -q my-project
```
Search projects by name or key

```bash
sonar list projects --page 2 --page-size 50
```
Paginate through projects

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

```bash
sonar analyze secrets --file src/config.ts
```
Scan a file for hardcoded secrets

```bash
cat .env | sonar analyze secrets --stdin
```
Scan stdin for hardcoded secrets

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

```bash
sonar config telemetry --enabled
```
Enable collection of anonymous usage statistics

```bash
sonar config telemetry --disabled
```
Disable collection of anonymous usage statistics

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

## License

Copyright 2026 SonarSource Sàrl.

SonarQube CLI is released under the [GNU Lesser General Public License, Version 3.0⁠,](http://www.gnu.org/licenses/lgpl.txt).

*Generated from `spec.yaml` — do not edit manually*
