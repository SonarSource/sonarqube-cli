#!/bin/bash
mkdir -p /logs/verifier
status=$("$HOME/.local/share/sonarqube-cli/bin/sonar" system status --format json 2>/dev/null | sed -n '/^{/,$p')
installed=$(jq -r '.integrations[].id' <<< "$status" 2>/dev/null)
others=$(grep -xE 'claude-code|codex|copilot-cli|cursor|antigravity|opencode' <<< "$installed" | grep -vx "$EXPECTED_INTEGRATION")
integration_installed=0
grep -qx "$EXPECTED_INTEGRATION" <<< "$installed" && integration_installed=1
no_other_integration=1
[ -n "$others" ] && no_other_integration=0
jq -n --argjson i "$integration_installed" --argjson o "$no_other_integration" \
  '{reward: ($i * $o), integration_installed: $i, no_other_integration: $o}' > /logs/verifier/reward.json
