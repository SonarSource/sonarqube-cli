#!/bin/bash
set -euo pipefail

usage="usage: sip.sh pull <data.json> | push <dir with index.html and data.json> (SIP_PLATFORM_TOKEN is the SIP token, SIP_APP_ID the app, default harbor-benchmark)"
token="${SIP_PLATFORM_TOKEN:?${usage}}"
app="${SIP_APP_ID:-harbor-benchmark}"
base="${SIP_BASE_URL:-https://internal.sip.sonarsource.io}"
interval="${SIP_POLL_INTERVAL:-15}"
action="${1:?${usage}}"
target="${2:?${usage}}"

command -v jq > /dev/null || { echo "jq is required" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

api() {
  curl -sS -H "Authorization: Bearer ${token}" "$@"
}

pull() {
  local status
  status="$(api -o "${target}" -w '%{http_code}' "${base}/apps/${app}/data.json")"
  case "${status}" in
    200) jq -e 'type == "array"' "${target}" > /dev/null || { echo "data.json of '${app}' is not a list of releases" >&2; exit 1; } ;;
    404) echo '[]' > "${target}" ;;
    *) echo "Cannot read data.json of '${app}' (HTTP ${status})" >&2; exit 1 ;;
  esac
}

upload() {
  local status attempt
  for attempt in 1 2 3; do
    status="$(api -X PUT -F "bundle=@${work}/bundle.zip" -o "${work}/upload.json" -w '%{http_code}' "${base}/api/bundle/${app}")"
    [[ "${status}" == 201 ]] && return 0
    [[ "${status}" == 504 ]] || break
    echo "Upload timed out (HTTP 504), attempt ${attempt} of 3" >&2
    sleep "${interval}"
  done
  echo "Upload failed (HTTP ${status})" >&2
  cat "${work}/upload.json" >&2
  exit 1
}

wait_for_checks() {
  local pull_request="$1" attempt
  for attempt in $(seq 1 40); do
    api --fail-with-body -o "${work}/checks.json" "${base}/api/bundle/${app}/checks"
    if [[ "$(jq -r .pullRequestUrl "${work}/checks.json")" == "${pull_request}" ]]; then
      if [[ "$(jq '.failedChecks | length' "${work}/checks.json")" != 0 ]]; then
        echo "Checks failed on ${pull_request}" >&2
        cat "${work}/checks.json" >&2
        exit 1
      fi
      [[ "$(jq -r .state "${work}/checks.json")" == SUCCESS ]] && return 0
    fi
    sleep "${interval}"
  done
  echo "Timed out waiting for the checks of ${pull_request}" >&2
  exit 1
}

merge() {
  api -X POST --fail-with-body -o "${work}/merge.json" "${base}/api/bundle/${app}/pull-request/merge"
  [[ "$(jq -r .state "${work}/merge.json")" == MERGED ]] || { echo "Merge failed" >&2; cat "${work}/merge.json" >&2; exit 1; }
}

wait_until_published() {
  local attempt
  for attempt in $(seq 1 40); do
    if [[ "$(api -o "${work}/published.json" -w '%{http_code}' "${base}/apps/${app}/data.json")" == 200 ]] \
      && cmp -s "${work}/published.json" "${target}/data.json"; then
      return 0
    fi
    sleep "${interval}"
  done
  echo "The data.json published for '${app}' still differs after the merge" >&2
  exit 1
}

push() {
  [[ -f "${target}/index.html" && -f "${target}/data.json" ]] || { echo "'${target}' needs index.html and data.json" >&2; exit 1; }
  mkdir "${work}/bundle"
  cp "${target}/index.html" "${target}/data.json" "${work}/bundle/"
  echo '{"classification": "Internal"}' > "${work}/bundle/classification.json"
  (cd "${work}/bundle" && zip -q "${work}/bundle.zip" index.html data.json classification.json)
  upload
  wait_for_checks "$(jq -r .pullRequestUrl "${work}/upload.json")"
  merge
  wait_until_published
}

case "${action}" in
  pull | push) "${action}" ;;
  *) echo "${usage}" >&2; exit 1 ;;
esac
