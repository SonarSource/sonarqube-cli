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

*Generated from `spec.yaml` — do not edit manually*
