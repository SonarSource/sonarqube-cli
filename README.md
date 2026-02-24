# sonar

SonarQube CLI

## Installation

```bash
brew install local/sonar/sonar
```

## Commands

### `sonar verify`

Analyze a file using SonarCloud A3S API

**Options:**

| Option           | Type   | Required | Description                                | Default |
| ---------------- | ------ | -------- | ------------------------------------------ | ------- |
| `--file`         | string | ✅        | File path to analyze                       | -       |
| `--organization` | string | ❌        | Organization key (or use saved config)     | -       |
| `--project`      | string | ❌        | Project key                                | -       |
| `--token`, `-t`  | string | ❌        | Authentication token (or use saved config) | -       |
| `--branch`, `-b` | string | ❌        | Branch name                                | -       |

**Examples:**

```bash
sonar verify --file src/MyClass.java
```
Analyze a single Java file

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

#### `sonar issues search`

Search for issues in SonarQube

**Options:**

| Option            | Type    | Required | Description                                    | Default |
| ----------------- | ------- | -------- | ---------------------------------------------- | ------- |
| `--server`, `-s`  | string  | ❌        | SonarQube server URL (or use saved connection) | -       |
| `--token`, `-t`   | string  | ❌        | Authentication token                           | -       |
| `--project`, `-p` | string  | ✅        | Project key                                    | -       |
| `--severity`      | string  | ❌        | Filter by severity                             | -       |
| `--format`        | string  | ❌        | Output format                                  | `json`  |
| `--branch`        | string  | ❌        | Branch name                                    | -       |
| `--pull-request`  | string  | ❌        | Pull request ID                                | -       |
| `--all`           | boolean | ❌        | Fetch all issues with pagination               | `false` |
| `--page-size`     | number  | ❌        | Page size for pagination                       | `500`   |

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

### `sonar projects`

Search for SonarQube projects

#### `sonar projects search`

Search for projects in SonarQube

**Options:**

| Option          | Type   | Required | Description                                                                                   | Default |
| --------------- | ------ | -------- | --------------------------------------------------------------------------------------------- | ------- |
| `--query`, `-q` | string | ❌        | An optional search query to filter projects by name (partial match) or key (exact match).     | -       |
| `--page`, `-p`  | number | ❌        | An optional page number. Defaults to 1.                                                       | `1`     |
| `--page-size`   | number | ❌        | An optional page size. Must be greater than 0 and less than or equal to 500. Defaults to 500. | `500`   |

**Examples:**

```bash
sonar projects search
```
List first 500 accessible projects

```bash
sonar projects search -q my-project
```
Search projects by name or key

```bash
sonar projects search --page 2 --page-size 50
```
Paginate through projects

---

### `sonar onboard-agent`

Setup SonarQube integration for AI coding agent

**Options:**

| Option              | Type    | Required | Description                       | Default  |
| ------------------- | ------- | -------- | --------------------------------- | -------- |
| `--server`, `-s`    | string  | ❌        | SonarQube server URL              | -        |
| `--project`, `-p`   | string  | ❌        | Project key                       | -        |
| `--token`, `-t`     | string  | ❌        | Existing authentication token     | -        |
| `--org`, `-o`       | string  | ❌        | Organization key (for SonarCloud) | -        |
| `--non-interactive` | boolean | ❌        | Non-interactive mode (no prompts) | `false`  |
| `--skip-hooks`      | boolean | ❌        | Skip hooks installation           | `false`  |
| `--hook-type`       | string  | ❌        | Hook type to install              | `prompt` |

**Examples:**

```bash
sonar onboard-agent claude -s https://sonarcloud.io -p my-project
```
Onboard Claude Code with interactive setup

```bash
sonar onboard-agent claude --skip-hooks --verbose
```
Onboard without installing hooks (verbose mode)

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

Show the current authentication status

**Examples:**

```bash
sonar auth status
```
Show current server connection and token status

---

### `sonar pre-commit`

Manage pre-commit hooks for secrets detection

#### `sonar pre-commit install`

Install Sonar secrets pre-commit hook

**Examples:**

```bash
sonar pre-commit install
```
Install pre-commit and configure SonarSource secrets hook

---

#### `sonar pre-commit uninstall`

Uninstall Sonar secrets pre-commit hook

**Examples:**

```bash
sonar pre-commit uninstall
```
Remove pre-commit hook and configuration file

---

### `sonar secret`

Manage sonar-secrets binary

#### `sonar secret install`

Install sonar-secrets binary

**Options:**

| Option    | Type    | Required | Description                               | Default |
| --------- | ------- | -------- | ----------------------------------------- | ------- |
| `--force` | boolean | ❌        | Force reinstall even if already installed | `false` |

**Examples:**

```bash
sonar secret install
```
Install latest sonar-secrets binary

```bash
sonar secret install --force
```
Reinstall sonar-secrets (overwrite existing)

---

#### `sonar secret status`

Check sonar-secrets installation status

**Examples:**

```bash
sonar secret status
```
Check if sonar-secrets is installed and up to date

---

#### `sonar secret check`

Scan a file or stdin for hardcoded secrets

**Options:**

| Option    | Type    | Required | Description                                | Default |
| --------- | ------- | -------- | ------------------------------------------ | ------- |
| `--file`  | string  | ❌        | File path to scan for secrets              | -       |
| `--stdin` | boolean | ❌        | Read from standard input instead of a file | -       |

**Examples:**

```bash
sonar secret check --file src/config.ts
```
Scan a file for hardcoded secrets

```bash
sonar secret check --file .env
```
Scan environment file for exposed secrets

```bash
cat .env | sonar secret check --stdin
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
