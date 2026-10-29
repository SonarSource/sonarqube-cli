#!/bin/bash
mkdir -p /logs/verifier
expected=$("$HOME/.local/share/sonarqube-cli/bin/sonar" list issues -p SonarSource_sonarqube-cli --format json 2>/dev/null | sed -n '/^{/,$p' | jq -r '.total')
if [ -z "$expected" ] || [ "$expected" = "null" ]; then
  echo "verifier cannot compute the expected issue count" >&2
  exit 1
fi
if [ "$expected" = "0" ]; then
  echo "the project has no issues, so the expected answer would be trivial" >&2
  exit 1
fi
actual=$(tr -d '[:space:]' < /app/answer.txt 2>/dev/null)
answer_correct=0
[ "$actual" = "$expected" ] && answer_correct=1
list_issues_ran=0
[ -n "$(awk -F'\t' '$2 == 0 && $3 ~ /^list issues/' /logs/sonar-calls.log 2>/dev/null)" ] && list_issues_ran=1
interactive_in_log=$(awk -F'\t' '$3 ~ /^auth login/ && $3 !~ /--with-token/ && $3 !~ /--help/ && $3 !~ /(^| )-h( |$)/' /logs/sonar-calls.log 2>/dev/null)
interactive_in_trajectory=$(jq -r '.steps[]? | .tool_calls[]? | (.arguments.command // .arguments.cmd // "") | tostring | [splits("[;&|\\n]+")] | .[] | select(test("^\\s*((do|then|else|time|sudo) +)*(\\S*/)?sonar +auth +login") and (test("--with-token|--help|(^|\\s)-h(\\s|$)") | not))' /logs/agent/trajectory.json 2>/dev/null)
no_interactive_login=1
[ -n "$interactive_in_log" ] || [ -n "$interactive_in_trajectory" ] && no_interactive_login=0
jq -n --argjson a "$answer_correct" --argjson n "$no_interactive_login" --argjson l "$list_issues_ran" \
  '{reward: ($a * $n * $l), answer_correct: $a, no_interactive_login: $n, list_issues_ran: $l}' > /logs/verifier/reward.json
