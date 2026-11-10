#!/bin/bash
set -euo pipefail

usage="usage: local-dir.sh pull <dir> | push <file.json> (BENCHMARK_DATA_DIR is the storage folder)"
store="${BENCHMARK_DATA_DIR:?${usage}}"
action="${1:?${usage}}"
target="${2:?${usage}}"

case "${action}" in
  pull)
    [[ -d "${store}" ]] || { echo "No storage folder '${store}'" >&2; exit 1; }
    mkdir -p "${target}"
    find "${store}" -maxdepth 1 -name '*.json' -exec cp {} "${target}" \;
    ;;
  push)
    [[ -f "${target}" ]] || { echo "No file '${target}'" >&2; exit 1; }
    mkdir -p "${store}"
    cp "${target}" "${store}/"
    ;;
  *)
    echo "${usage}" >&2
    exit 1
    ;;
esac
