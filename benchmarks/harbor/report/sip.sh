#!/bin/bash
set -euo pipefail

usage="usage: sip.sh pull <dir> | push <dir with index.html and index.json> (SIP_PLATFORM_TOKEN is the SIP token, SIP_APP_ID the app, default harbor-benchmark)"
token="${SIP_PLATFORM_TOKEN:?${usage}}"
app="${SIP_APP_ID:-harbor-benchmark}"
base="${SIP_BASE_URL:-https://internal.sip.sonarsource.io}"
interval="${SIP_POLL_INTERVAL:-15}"
max_file_bytes=$((10 * 1024 * 1024))
max_zip_bytes=$((50 * 1024 * 1024))
action="${1:?${usage}}"
target="${2:?${usage}}"

command -v jq > /dev/null || { echo "jq is required" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
pull_request=""

api() {
  curl -sS -H "Authorization: Bearer ${token}" "$@"
}

download() {
  local path paths=()
  while IFS= read -r path; do paths+=("${path}"); done
  [[ ${#paths[@]} -gt 0 ]] || return 0
  : > "${work}/fetch.conf"
  for path in "${paths[@]}"; do
    printf 'url = "%s/apps/%s/%s"\noutput = "%s/%s"\n' "${base}" "${app}" "${path}" "${target}" "${path}" >> "${work}/fetch.conf"
  done
  for path in "${paths[@]}"; do rm -f "${target}/${path}"; done
  api --parallel --parallel-max 8 --fail --retry 3 --create-dirs --config "${work}/fetch.conf"
  for path in "${paths[@]}"; do
    jq -e . "${target}/${path}" > /dev/null || { echo "'${path}' of '${app}' is missing or is not JSON after the download" >&2; exit 1; }
  done
}

pull() {
  local status id ids
  mkdir -p "${target}"
  status="$(api -o "${target}/index.json" -w '%{http_code}' "${base}/apps/${app}/index.json")"
  case "${status}" in
    200) jq -e '.schemaVersion == 2' "${target}/index.json" > /dev/null || { echo "index.json of '${app}' is not a Harbor site index" >&2; exit 1; } ;;
    404)
      [[ "$(api -o /dev/null -w '%{http_code}' "${base}/apps/${app}/data.json")" == 200 ]] \
        || { echo "'${app}' has neither index.json nor the former data.json: refusing to publish over an unknown site" >&2; exit 1; }
      echo "No index.json on '${app}': the former data.json is replaced by an empty site" >&2
      echo '{"schemaVersion":2,"reference":null,"recent":[],"formerReferences":[]}' > "${target}/index.json"
      return 0
      ;;
    *) echo "Cannot read index.json of '${app}' (HTTP ${status})" >&2; exit 1 ;;
  esac
  jq -r '([.reference // empty] + .recent)[] | "runs/\(.)/run.json"' "${target}/index.json" | download
  jq -r '.formerReferences[] | "references/\(.).json"' "${target}/index.json" | download
  ids="$(jq -r '[.reference // empty] + .recent | .[]' "${target}/index.json")"
  for id in ${ids}; do
    jq -r --arg id "${id}" '.trials[] | "runs/\($id)/trials/\(.id).json"' "${target}/runs/${id}/run.json" | download
  done
}

last_pull_request() {
  api --fail-with-body "${base}/api/bundle/${app}/checks" 2> /dev/null | jq -r '.pullRequestUrl // empty' || true
}

upload() {
  local before status attempt
  before="$(last_pull_request)"
  status="$(api -X PUT -F "bundle=@${work}/bundle.zip" -o "${work}/upload.json" -w '%{http_code}' "${base}/api/bundle/${app}")"
  case "${status}" in
    201)
      pull_request="$(jq -r .pullRequestUrl "${work}/upload.json")"
      return 0
      ;;
    504) echo "Upload timed out (HTTP 504), SIP is still working on it: waiting for its pull request" >&2 ;;
    *)
      echo "Upload failed (HTTP ${status})" >&2
      cat "${work}/upload.json" >&2
      exit 1
      ;;
  esac
  for attempt in $(seq 1 40); do
    sleep "${interval}"
    pull_request="$(last_pull_request)"
    [[ -n "${pull_request}" && "${pull_request}" != "${before}" ]] && return 0
  done
  echo "No new pull request after the timeout, the last one is still ${before:-unknown}: close it if it is still open, then run again" >&2
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
    if [[ "$(api -o "${work}/published.json" -w '%{http_code}' "${base}/apps/${app}/index.json")" == 200 ]] \
      && cmp -s "${work}/published.json" "${target}/index.json"; then
      return 0
    fi
    sleep "${interval}"
  done
  echo "The index.json published for '${app}' still differs after the merge" >&2
  exit 1
}

check_sizes() {
  local biggest zip_bytes
  biggest="$(find "${work}/bundle" -type f -exec wc -c {} + | awk '$2 != "total" {print $1}' | sort -n | tail -1)"
  zip_bytes="$(wc -c < "${work}/bundle.zip" | tr -d ' ')"
  echo "Bundle: $(find "${work}/bundle" -type f | wc -l | tr -d ' ') files, zip ${zip_bytes} bytes, biggest file ${biggest} bytes" >&2
  [[ "${biggest}" -le "${max_file_bytes}" ]] || { echo "A file is over the SIP limit of ${max_file_bytes} bytes" >&2; exit 1; }
  [[ "${zip_bytes}" -le "${max_zip_bytes}" ]] || { echo "The zip is over the SIP limit of ${max_zip_bytes} bytes" >&2; exit 1; }
}

push() {
  [[ -f "${target}/index.html" && -f "${target}/index.json" ]] || { echo "'${target}' needs index.html and index.json" >&2; exit 1; }
  mkdir "${work}/bundle"
  cp -R "${target}/." "${work}/bundle/"
  echo '{"classification": "Internal"}' > "${work}/bundle/classification.json"
  (cd "${work}/bundle" && zip -q -r "${work}/bundle.zip" .)
  check_sizes
  upload
  wait_for_checks "${pull_request}"
  merge
  wait_until_published
}

case "${action}" in
  pull | push) "${action}" ;;
  *) echo "${usage}" >&2; exit 1 ;;
esac
