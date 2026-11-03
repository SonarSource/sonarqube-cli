#!/usr/bin/env bash
# Shared integration scope runner for CI (full suite, narrowed file, optional repeat-until-failure).
set -euo pipefail

echo "run-integration-scope: cwd=$(pwd)"
echo "run-integration-scope: INTEGRATION_TEST_PATH=${INTEGRATION_TEST_PATH:-<unset>}"
echo "run-integration-scope: INTEGRATION_SHARD_INDEX=${INTEGRATION_SHARD_INDEX:-<unset>}"
echo "run-integration-scope: INTEGRATION_SHARD_TOTAL=${INTEGRATION_SHARD_TOTAL:-<unset>}"
echo "run-integration-scope: INTEGRATION_UNTIL_FAILURE=${INTEGRATION_UNTIL_FAILURE:-<unset>}"
echo "run-integration-scope: USE_COVERAGE=${USE_COVERAGE:-0}"

run_bun_test() {
  local -a test_paths=("$@")
  local log
  log="$(mktemp)"
  set +e
  if [ "${USE_COVERAGE:-0}" = "1" ]; then
    SONARQUBE_CLI_USE_COVERAGE=1 bun test --parallel=4 "${test_paths[@]}" 2>&1 | tee "${log}"
  else
    bun test --parallel=4 "${test_paths[@]}" 2>&1 | tee "${log}"
  fi
  local status=${PIPESTATUS[0]}
  set -e
  if grep -qE 'Ran 0 tests|[^0-9]0 pass' "${log}"; then
    echo "No integration tests ran — refusing to treat as success."
    cat "${log}"
    rm -f "${log}"
    return 1
  fi
  rm -f "${log}"
  return "${status}"
}

run_once() {
  if [ "${INTEGRATION_SHARDED:-false}" = true ] || [ "${INTEGRATION_SHARDED:-false}" = True ]; then
    mapfile -t shard_paths < <(bash .github/scripts/integration-shard-paths.sh)
    echo "Integration shard ${INTEGRATION_SHARD_INDEX}/${INTEGRATION_SHARD_TOTAL}:"
    printf '  %s\n' "${shard_paths[@]}"
    run_bun_test "${shard_paths[@]}"
    return $?
  fi

  if [ -n "${INTEGRATION_TEST_PATH:-}" ]; then
    path="./${INTEGRATION_TEST_PATH#./}"
    echo "Narrow integration scope: ${path}"
    if [ ! -f "${path}" ] && [ ! -d "${path}" ]; then
      echo "Integration test path not found: ${path}"
      ls -la tests/integration/specs/integrate/ 2>/dev/null || true
      exit 1
    fi
    run_bun_test "${path}"
    return $?
  fi

  if [ "${USE_COVERAGE:-0}" = "1" ]; then
    SONARQUBE_CLI_USE_COVERAGE=1 bun run test:integration
  else
    bun run test:integration
  fi
}

until_failure=false
case "${INTEGRATION_UNTIL_FAILURE:-false}" in
  true | True | TRUE) until_failure=true ;;
esac

if [ "${until_failure}" = true ]; then
  attempt=0
  while true; do
    attempt=$((attempt + 1))
    echo "=== integration scope attempt ${attempt} ==="
    if ! run_once; then
      echo "Integration scope failed on attempt ${attempt} (flake reproduction)."
      exit 1
    fi
    echo "Integration scope passed (attempt ${attempt}); re-running until failure..."
  done
else
  run_once
fi
