# SonarQube CLI

A CLI application for interacting with SonarQube products. This product is currently in Open Beta and we are actively collecting feedback on it. Please share your thoughts via [this form](https://forms.gle/xE61HS2E5NzxFCSR9)!

## Installation

**Linux/Mac OS:**

```bash
curl -o- https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts/install.sh | bash
```

**Windows (from PowerShell):**

```powershell
irm https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts/install.ps1 | iex
```

## Commands

<!-- COMMANDS -->

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

*Generated from `src/cli/command-tree.ts` — do not edit manually*
