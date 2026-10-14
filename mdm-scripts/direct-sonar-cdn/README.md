Reference copies of the JumpCloud Custom Commands for deploying the SonarQube CLI from the SonarSource CDN. The production commands live in the HelpDesk repository under `jumpcloud/{mac,linux,windows}/IS > Dev > <OS> > <Action> SonarQube CLI [(Permissive)]`.

`install-bootstrap.sh` (macOS, Linux) and `install-bootstrap.ps1` (Windows) download and verify the CLI, then run `sonar mdm install`. Update, rollback and remove run `sonar mdm <action>` from the installed CLI; when it predates `sonar mdm` or is missing, they download and verify the stable release and run the action from it.

| Permissive behaviour | `sonar mdm` flag |
|---|---|
| install only when no binary is present | `install --skip-if-present` |
| leave per-user standalone installs alone (Windows never links them) | `install --skip-standalone-links` |
| continue with a warning when the `.sha256` file cannot be fetched | `update\|rollback --allow-missing-checksum` |
| remove only the MDM binary | `remove --mdm-binary-only` |

`--artifact-base-url` takes the same value as the existing `SONARQUBE_CLI_ARTIFACT_BASE_URL` JumpCloud variable (default `https://binaries.sonarsource.com/Distribution/sonarqube-cli`).
