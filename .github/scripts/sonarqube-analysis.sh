#!/bin/bash

set -euo pipefail

: "${SONAR_HOST_URL:?}"
: "${SONAR_TOKEN:?}"
: "${BUILD_NUMBER:?}"
: "${GITHUB_RUN_ID:?}"
: "${GITHUB_SHA:?}"
: "${GITHUB_REPOSITORY:?}"
: "${CURRENT_VERSION:?}"
: "${PULL_REQUEST?}"
: "${DEFAULT_BRANCH:?}"
: "${GITHUB_REF_NAME:?}"

echo '======= Starting GitHub Actions SonarQube Analysis'
echo "Branch:       ${GITHUB_REF_NAME}"
echo "Pull Request: ${PULL_REQUEST}"
echo "Build Number: ${BUILD_NUMBER}"

# Check if SONAR_HOST_URL refers to SQC US and set region parameter accordingly
if [[ "${SONAR_HOST_URL}" == *"sonarqube.us"* ]]; then
  export SONAR_REGION="US"
fi

build_javascript_lcov_report_paths() {
  local -a paths=()
  local unit_lcov='tests/coverage/reports/unit/lcov.info'
  local shard_lcov
  local has_integration_shards=false

  if [[ -f "${unit_lcov}" ]]; then
    paths+=("${unit_lcov}")
  fi

  while IFS= read -r -d '' shard_lcov; do
    paths+=("${shard_lcov}")
    has_integration_shards=true
  done < <(find tests/coverage/reports -maxdepth 1 -name 'lcov.integration-shard-*.info' -print0 | sort -z)

  if [[ "${has_integration_shards}" != true ]] && [[ -f tests/coverage/reports/integration/lcov.info ]]; then
    paths+=('tests/coverage/reports/integration/lcov.info')
  fi

  if ((${#paths[@]} == 0)); then
    return 0
  fi

  local joined
  joined=$(IFS=,; echo "${paths[*]}")
  echo "-Dsonar.javascript.lcov.reportPaths=${joined}"
}

sonar_scanner_implementation() {
  local additional_params=("$@")
  local scanner_args=()
  local lcov_paths_param

  scanner_args+=("-Dsonar.host.url=${SONAR_HOST_URL}")
  scanner_args+=("-Dsonar.token=${SONAR_TOKEN}")
  scanner_args+=("-Dsonar.analysis.buildNumber=${BUILD_NUMBER}")
  scanner_args+=("-Dsonar.analysis.pipeline=${GITHUB_RUN_ID}")
  scanner_args+=("-Dsonar.analysis.repository=${GITHUB_REPOSITORY}")
  scanner_args+=("-Dsonar.projectVersion=${CURRENT_VERSION}")

  if [[ -n "${SONAR_REGION:-}" ]]; then
    scanner_args+=("-Dsonar.region=${SONAR_REGION}")
  fi
  lcov_paths_param=$(build_javascript_lcov_report_paths || true)
  if [[ -n "${lcov_paths_param}" ]]; then
    scanner_args+=("${lcov_paths_param}")
  fi
  scanner_args+=("${additional_params[@]+${additional_params[@]}}")

  echo "sonar command: npx sonar-scanner-npm ${scanner_args[*]}"
  npx sonar-scanner-npm "${scanner_args[@]}"
  return 0
}

if [[ "${GITHUB_REF_NAME}" == "${DEFAULT_BRANCH}" ]] && [[ "${PULL_REQUEST}" == "false" ]]; then
  echo '======= Analyze default branch'
  git fetch origin "${GITHUB_REF_NAME}"
  sonar_scanner_implementation

elif [[ "${GITHUB_REF_NAME}" == "branch-"* ]] && [[ "${PULL_REQUEST}" == "false" ]]; then
  echo '======= Analyze maintenance branch'
  git fetch origin "${GITHUB_REF_NAME}"
  sonar_scanner_implementation \
    "-Dsonar.branch.name=${GITHUB_REF_NAME}"

elif [[ "${PULL_REQUEST}" != "false" ]]; then
  echo '======= Analyze pull request'
  sonar_scanner_implementation \
    "-Dsonar.analysis.prNumber=${PULL_REQUEST}"

elif [[ "${GITHUB_REF_NAME}" == "feature/long/"* ]] && [[ "${PULL_REQUEST}" == "false" ]]; then
  echo '======= Analyze long-lived feature branch'
  sonar_scanner_implementation \
    "-Dsonar.branch.name=${GITHUB_REF_NAME}"

else
  echo '======= No analysis'
fi

echo '======= GitHub Actions SonarQube Analysis Complete'
