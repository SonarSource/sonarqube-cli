#!/bin/bash
set -e
sonar list issues -p SonarSource_sonarqube-cli --format json | sed -n "/^{/,\$p" | jq -r .total > /app/answer.txt
