#!/bin/bash

mkdir -p /logs/verifier

expected_version=$(sonar --version 2>&1 | grep -Eo '^[0-9]+(\.[0-9]+)+' | tail -n 1)
expected_agents=$(sonar integrate --help 2>&1 | sed -nE 's/^  ([a-z]+) \[options\].*/\1/p' | grep -vx git | sort)
actual_version=$(tr -d '[:space:]' < /app/version.txt 2>/dev/null)
actual_agents=$(tr -d '\r' < /app/agents.txt 2>/dev/null | sed '/^[[:space:]]*$/d' | grep -vx git | sort)

if [[ -n "$expected_version" && -n "$expected_agents" \
  && "$actual_version" == "$expected_version" \
  && "$actual_agents" == "$expected_agents" ]]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
