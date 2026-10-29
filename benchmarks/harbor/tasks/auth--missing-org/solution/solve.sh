#!/bin/bash
set -e
org=$(sed -n 's/^sonar.organization=//p' /app/sonar-project.properties)
SONARQUBE_CLI_ORG="$org" sonar list issues -p SonarSource_sonarqube-cli --format json | sed -n "/^{/,\$p" | jq -r .total > /app/answer.txt
