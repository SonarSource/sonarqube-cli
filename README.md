# sonar

SonarQube CLI

## Installation

```bash
brew install local/sonar/sonar
```

## Commands

### `sonar install`

Install Sonar tools

#### `sonar install secrets`

Install sonar-secrets binary from binaries.sonarsource.com

**Options:**

| Option     | Type    | Required | Description                                     | Default |
| ---------- | ------- | -------- | ----------------------------------------------- | ------- |
| `--force`  | boolean | ❌        | Force reinstall even if already installed       | `false` |
| `--status` | boolean | ❌        | Check installation status instead of installing | `false` |

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

| Option              | Type    | Required | Description                       | Default |
| ------------------- | ------- | -------- | --------------------------------- | ------- |
| `--server`, `-s`    | string  | ❌        | SonarQube server URL              | -       |
| `--project`, `-p`   | string  | ❌        | Project key                       | -       |
| `--token`, `-t`     | string  | ❌        | Existing authentication token     | -       |
| `--org`, `-o`       | string  | ❌        | Organization key (for SonarCloud) | -       |
| `--non-interactive` | boolean | ❌        | Non-interactive mode (no prompts) | `false` |
| `--skip-hooks`      | boolean | ❌        | Skip hooks installation           | `false` |

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
| `--server`, `-s`  | string  | ❌        | SonarQube server URL             | -       |
| `--token`, `-t`   | string  | ❌        | Authentication token             | -       |
| `--project`, `-p` | string  | ✅        | Project key                      | -       |
| `--severity`      | string  | ❌        | Filter by severity               | -       |
| `--format`        | string  | ❌        | Output format                    | `json`  |
| `--branch`        | string  | ❌        | Branch name                      | -       |
| `--pull-request`  | string  | ❌        | Pull request ID                  | -       |
| `--all`           | boolean | ❌        | Fetch all issues with pagination | `false` |
| `--page-size`     | number  | ❌        | Page size for pagination         | `500`   |

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
| `--query`, `-q` | string | ❌        | Search query to filter projects by name or key | -       |
| `--page`, `-p`  | number | ❌        | Page number                                    | `1`     |
| `--page-size`   | number | ❌        | Page size (1-500)                              | `500`   |

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

### `sonar auth`

Manage authentication tokens and credentials

#### `sonar auth login`

Save authentication token to keychain

**Options:**

| Option               | Type   | Required | Description                                           | Default |
| -------------------- | ------ | -------- | ----------------------------------------------------- | ------- |
| `--server`, `-s`     | string | ❌        | SonarQube server URL (default is SonarCloud)          | -       |
| `--org`, `-o`        | string | ❌        | SonarCloud organization key (required for SonarCloud) | -       |
| `--with-token`, `-t` | string | ❌        | Token value (skips browser, non-interactive mode)     | -       |

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
| `--server`, `-s` | string | ❌        | SonarQube server URL                                  | -       |
| `--org`, `-o`    | string | ❌        | SonarCloud organization key (required for SonarCloud) | -       |

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

### `sonar analyze`

Analyze code for security issues

#### `sonar analyze secrets`

Scan a file or stdin for hardcoded secrets

**Options:**

| Option    | Type    | Required | Description                                | Default |
| --------- | ------- | -------- | ------------------------------------------ | ------- |
| `--file`  | string  | ❌        | File path to scan for secrets              | -       |
| `--stdin` | boolean | ❌        | Read from standard input instead of a file | -       |

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

## License

Copyright 2026 SonarSource Sàrl.

SonarQube CLI is released under the [GNU Lesser General Public License, Version 3.0⁠,](http://www.gnu.org/licenses/lgpl.txt).

*Generated from `spec.yaml` — do not edit manually*
