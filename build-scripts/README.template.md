# SonarQube CLI

[![Build](https://github.com/SonarSource/sonarqube-cli/actions/workflows/build.yml/badge.svg?branch=master)](https://github.com/SonarSource/sonarqube-cli/actions/workflows/build.yml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=SonarSource_sonarqube-cli&metric=alert_status&token=4ad890bd54c6c3feb5d5251004fa3e5b1f665dea)](https://sonarcloud.io/summary/new_code?id=SonarSource_sonarqube-cli)

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

## Contributing

Please be aware that we are not actively looking for feature contributions. The truth is that it's extremely difficult for someone outside
SonarSource to comply with our roadmap and expectations. Therefore, we typically only accept minor cosmetic changes and typo fixes.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup instructions, coding guidelines, and how to run tests.

## License

Copyright 2026 SonarSource Sàrl.

SonarQube CLI is released under the [GNU Lesser General Public License, Version 3.0⁠,](http://www.gnu.org/licenses/lgpl.txt).

*Generated from `src/cli/command-tree.ts` — do not edit manually*
