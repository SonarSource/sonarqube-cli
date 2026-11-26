#!/bin/bash
set -euo pipefail
# Installs the SonarQube agent plugin where Harbor makes the agent read its config, when the run asks for it.
marker=/logs/agent/sonarqube-agent-plugin.json
plugin_dir="${HB_AGENT_PLUGIN_DIR:-}"
mkdir -p /logs/agent
if [[ -z "$plugin_dir" ]]; then
  jq -n '{installed: false}' > "$marker"
  exit 0
fi
version="$(jq -r .version "$plugin_dir/.claude-plugin/plugin.json")"
case "$AGENT" in
  claude-code)
    # Harbor starts Claude Code with this config directory and only creates folders in it.
    export CLAUDE_CONFIG_DIR=/logs/agent/sessions
    mkdir -p "$CLAUDE_CONFIG_DIR"
    claude plugin marketplace add "$plugin_dir" >&2
    claude plugin install sonarqube@sonar --scope user >&2
    claude plugin list | grep -q 'sonarqube@sonar' || { echo "sonarqube@sonar is not installed for Claude Code" >&2; exit 1; }
    ;;
  codex)
    # Harbor rewrites config.toml before the run, so run-isolated.sh adds the plugin tables to the config it passes.
    export CODEX_HOME=/installed-agent/codex-home
    mkdir -p "$CODEX_HOME"
    codex plugin marketplace add "$plugin_dir" >&2
    codex plugin add sonarqube@sonar >&2
    [[ -d "$CODEX_HOME/plugins/cache/sonar/sonarqube/$version" ]] || { echo "sonarqube@sonar $version is not in the Codex plugin cache" >&2; exit 1; }
    ;;
  *)
    echo "No SonarQube agent plugin for agent '$AGENT'" >&2
    exit 1
    ;;
esac
jq -n --arg ref "${HB_AGENT_PLUGIN_REF:-}" --arg version "$version" \
  '{installed: true, ref: $ref, version: $version}' > "$marker"
