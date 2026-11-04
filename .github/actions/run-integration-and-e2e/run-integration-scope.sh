#!/usr/bin/env bash
# Run integration tests for one CI hash shard (see integration-shard-paths.sh).
set -euo pipefail

action_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${INTEGRATION_SHARD_INDEX:?INTEGRATION_SHARD_INDEX is required}"
: "${INTEGRATION_SHARD_TOTAL:?INTEGRATION_SHARD_TOTAL is required}"

run_bun_test() {
  local -a test_paths=("$@")
  if [ "${#test_paths[@]}" -eq 0 ]; then
    echo "run-integration-scope: refusing to run bun test with no paths (would run the whole repo)" >&2
    return 1
  fi
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

if ! mapfile -t shard_paths < <(bash "${action_dir}/integration-shard-paths.sh"); then
  echo "integration-shard-paths.sh failed for shard ${INTEGRATION_SHARD_INDEX}/${INTEGRATION_SHARD_TOTAL}" >&2
  exit 1
fi
if [ "${#shard_paths[@]}" -eq 0 ]; then
  echo "Integration shard ${INTEGRATION_SHARD_INDEX}/${INTEGRATION_SHARD_TOTAL} resolved no paths" >&2
  exit 1
fi

echo "Integration shard ${INTEGRATION_SHARD_INDEX}/${INTEGRATION_SHARD_TOTAL}:"
printf '  %s\n' "${shard_paths[@]}"
run_bun_test "${shard_paths[@]}"
