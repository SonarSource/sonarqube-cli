#!/bin/bash
set -euo pipefail
integrate() {
  local agent="$1"
  SONARQUBE_CLI_TOKEN="$HB_SONAR_TOKEN" SONARQUBE_CLI_ORG="$HB_SONAR_ORG" \
    SONARQUBE_CLI_SERVER="${HB_SONAR_SERVER:-https://sonarcloud.io}" \
    SONARQUBE_CLI_SONARCLOUD_URL="${HB_SONAR_SERVER:-https://sonarcloud.io}" \
    SONARQUBE_CLI_SONARCLOUD_API_URL="${HB_SONAR_API_URL:-https://api.sonarcloud.io}" \
    "$HOME/.local/share/sonarqube-cli/bin/sonar" integrate "$agent" --non-interactive >&2
}
case "$AGENT" in
  claude-code)
    integrate claude
    mkdir -p /app/.claude
    jq '{hooks: .hooks}' "$HOME/.claude/settings.json" > /app/.claude/settings.json
    ;;
  codex)
    integrate codex
    mkdir -p /installed-agent/codex-home
    cp -r "$HOME/.codex/hooks" "$HOME/.codex/hooks.json" /installed-agent/codex-home/
    ;;
  *)
    echo "No hooks for agent '$AGENT'" >&2
    exit 1
    ;;
esac
touch /tmp/sonar-ready
