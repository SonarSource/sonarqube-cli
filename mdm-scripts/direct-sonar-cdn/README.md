Reference copies of the JumpCloud Custom Commands for deploying the SonarQube CLI from the SonarSource CDN.

`install-bootstrap.sh` (macOS, Linux) and `install-bootstrap.ps1` (Windows) download and verify the CLI, then run `sonar mdm install`. Update, rollback and remove run `sonar mdm <action>` from the installed CLI; when it predates `sonar mdm` or is missing, they download and verify the stable release and run the action from it.

| Permissive behaviour | `sonar mdm` flag |
|---|---|
| install only when no binary is present | `install --skip-if-present` |
| leave per-user standalone installs alone (Windows never links them) | `install --skip-standalone-links` |
| continue with a warning when the `.sha256` file cannot be fetched | `update\|rollback --allow-missing-checksum` |
| remove only the MDM binary | `remove --mdm-binary-only` |

`--artifact-base-url` takes the same value as the existing `SONARQUBE_CLI_ARTIFACT_BASE_URL` JumpCloud variable (default `https://binaries.sonarsource.com/Distribution/sonarqube-cli`).

`install-bootstrap.sh` and `install-bootstrap.ps1` accept the optional variable `SONARQUBE_CLI_MANAGED_MESSAGE`, passed to `sonar mdm install --managed-message`. Installing writes a `sonar.managed` file next to the system-wide binary, and `sonar update` on that installation prints its text (by default, a request to contact the administrator) instead of updating. `sonar mdm remove` deletes the file.
