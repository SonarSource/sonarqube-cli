#!/bin/bash
set -euo pipefail

usage="usage: git-branch.sh pull <dir> | push <file.json> (BENCHMARK_DATA_REMOTE is the repository, BENCHMARK_DATA_BRANCH the branch, default benchmark-data)"
remote="${BENCHMARK_DATA_REMOTE:?${usage}}"
branch="${BENCHMARK_DATA_BRANCH:-benchmark-data}"
action="${1:?${usage}}"
target="${2:?${usage}}"

export GIT_TERMINAL_PROMPT=0
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
git init -q "${work}"
git -C "${work}" remote add origin "${remote}"

branch_exists() {
  local status=0
  git -C "${work}" ls-remote --exit-code --heads origin "${branch}" > /dev/null || status=$?
  case "${status}" in
    0) return 0 ;;
    2) return 1 ;;
    *) echo "Cannot reach '${remote}'" >&2; exit 1 ;;
  esac
}

case "${action}" in
  pull)
    branch_exists || { echo "No branch '${branch}' in '${remote}'" >&2; exit 1; }
    git -C "${work}" fetch -q --depth 1 origin "${branch}"
    git -C "${work}" checkout -q FETCH_HEAD
    mkdir -p "${target}"
    find "${work}" -maxdepth 1 -name '*.json' -exec cp {} "${target}" \;
    ;;
  push)
    [[ -f "${target}" ]] || { echo "No file '${target}'" >&2; exit 1; }
    if branch_exists; then
      git -C "${work}" fetch -q --depth 1 origin "${branch}"
      git -C "${work}" checkout -q -B "${branch}" FETCH_HEAD
    else
      git -C "${work}" checkout -q --orphan "${branch}"
    fi
    cp "${target}" "${work}/"
    git -C "${work}" add -- "$(basename "${target}")"
    if git -C "${work}" diff --cached --quiet; then
      echo "$(basename "${target}") is already stored" >&2
      exit 0
    fi
    git -C "${work}" -c user.name=harbor-benchmark -c user.email=harbor-benchmark@users.noreply.github.com \
      commit -q -m "Add $(basename "${target}")"
    git -C "${work}" push -q origin "HEAD:refs/heads/${branch}"
    ;;
  *)
    echo "${usage}" >&2
    exit 1
    ;;
esac
