#!/bin/bash
set -euo pipefail
SONARQUBE_CLI_TOKEN="$HB_SONAR_TOKEN" SONARQUBE_CLI_ORG="$HB_SONAR_ORG" \
  SONARQUBE_CLI_SERVER="${HB_SONAR_SERVER:-https://sonarcloud.io}" \
  SONARQUBE_CLI_SONARCLOUD_URL="${HB_SONAR_SERVER:-https://sonarcloud.io}" \
  SONARQUBE_CLI_SONARCLOUD_API_URL="${HB_SONAR_API_URL:-https://api.sonarcloud.io}" \
  "$HOME/.local/share/sonarqube-cli/bin/sonar" integrate claude --non-interactive >&2
mkdir -p /app/.claude
jq '{hooks: .hooks}' "$HOME/.claude/settings.json" > /app/.claude/settings.json
