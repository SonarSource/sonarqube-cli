#!/bin/bash
set -euo pipefail
mkdir -p /app
cd /app
git init -q
printf 'sonar.projectKey=SonarSource_sonarqube-cli\nsonar.organization=sonarsource\n' > sonar-project.properties
