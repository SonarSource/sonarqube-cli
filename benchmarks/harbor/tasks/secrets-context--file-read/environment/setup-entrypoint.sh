#!/bin/bash
set -e
real=/root/.local/share/sonarqube-cli/bin/sonar
"$real" integrate claude --non-interactive > /dev/null 2>&1
"$real" integrate codex --non-interactive > /dev/null 2>&1
mkdir -p /app/.claude
jq '{hooks: .hooks}' /root/.claude/settings.json > /app/.claude/settings.json
mkdir -p /installed-agent/codex-home
cp -r /root/.codex/hooks /root/.codex/hooks.json /installed-agent/codex-home/
touch /tmp/sonar-ready
exec "$@"
