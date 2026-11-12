#!/bin/bash
: "${EXPECTED_INTEGRATION:?EXPECTED_INTEGRATION is required}"
mkdir -p /logs/verifier
status=$("$HOME/.local/share/sonarqube-cli/bin/sonar" system status --format json 2>/dev/null | sed -n '/^{/,$p')
installed=$(jq -r '.integrations[].id' <<< "$status" 2>/dev/null)
others=$(grep -vx "$EXPECTED_INTEGRATION" <<< "$installed")
integration_installed=0
grep -qx "$EXPECTED_INTEGRATION" <<< "$installed" && integration_installed=1
no_other_integration=1
[ -n "$others" ] && no_other_integration=0

calls_log=/logs/sonar-calls.log
[ -f "$calls_log" ] || calls_log=/dev/null
trajectory=/logs/agent/trajectory.json
if [ ! -f "$trajectory" ]; then
  trajectory=$(mktemp)
  echo '{"steps":[]}' > "$trajectory"
fi
[ "$calls_log" = /logs/sonar-calls.log ] && cp "$calls_log" /logs/verifier/sonar-calls.log
quality=$(jq -n --rawfile log "$calls_log" --slurpfile traj "$trajectory" -f "$(dirname "$0")/quality.jq")
jq '.measures' <<< "$quality" > /logs/verifier/measures.json

jq -n --argjson i "$integration_installed" --argjson o "$no_other_integration" --argjson q "$quality" \
  '{reward: ($i * $o), integration_installed: $i, no_other_integration: $o, quality: $q.quality, score: ($i * $o * $q.quality)} + $q.scores' \
  > /logs/verifier/reward.json
