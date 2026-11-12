#!/usr/bin/env bash
set -euo pipefail

AGENT_USER=nobody
RUN_ROOT=/usr/local/share/harbor-run
AGENT_HOME="${RUN_ROOT}/home"
WORKDIR="${RUN_ROOT}/work"
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="${WORKDIR}/harbor/scripts/run-isolated.sh"
AGENT_PATH="${AGENT_HOME}/.local/bin:${AGENT_HOME}/.local/share/sonarqube-cli/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
INSTALL_ENV=ARTIFACTORY_USER,ARTIFACTORY_ACCESS_TOKEN,HARBOR_VERSION,HARBOR_PYTHON_VERSION,UV_VERSION,AGENT,CODEX_VERSION
RUN_ENV=PORTKEY_API_KEY,AGENT,MODEL,JOB_NAME,TASK,HB_SONAR_TOKEN,HB_SONAR_ORG,HB_SONAR_SERVER,HB_SONAR_API_URL,HARBOR_HOST_ENVIRONMENT_ALLOW
ROOT_DIR_NAMES=(app logs tests solution installed-agent)

as_agent() {
  local preserved_env="$1"
  shift
  (cd "${AGENT_HOME}" && sudo --preserve-env="${preserved_env}" -u "${AGENT_USER}" -H env HOME="${AGENT_HOME}" PATH="${AGENT_PATH}" "$@")
}

create_root_dirs() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    sudo mkdir -p /etc/synthetic.d
    for name in "${ROOT_DIR_NAMES[@]}"; do
      sudo mkdir -p "${RUN_ROOT}/fs/${name}"
      printf '%s\t%s\n' "${name}" "${RUN_ROOT}/fs/${name}"
    done | sudo tee /etc/synthetic.d/harbor >/dev/null
    sudo /System/Library/Filesystems/apfs.fs/Contents/Resources/apfs.util -t || echo "apfs.util exited with $?"
    sudo chown -R "${AGENT_USER}" "${RUN_ROOT}/fs"
  else
    for name in "${ROOT_DIR_NAMES[@]}"; do
      sudo mkdir -p "/${name}"
      sudo chown "${AGENT_USER}" "/${name}"
    done
  fi
  ls -ld /app /logs /tests /solution /installed-agent
}

prepare() {
  sudo mkdir -p "${AGENT_HOME}" "${WORKDIR}/harbor"
  sudo cp -R "${SOURCE_ROOT}/." "${WORKDIR}/harbor/"
  create_root_dirs
  sudo chown -R "${AGENT_USER}" "${RUN_ROOT}/home" "${WORKDIR}"
}

assert_agent_cannot_sudo() {
  if as_agent PATH sudo -n true 2>/dev/null; then
    echo "The agent user can run sudo, refusing to start the agent" >&2
    exit 1
  fi
}

collect_results() {
  local source_dir="${WORKDIR}/harbor-jobs"
  sudo pkill -KILL -u "${AGENT_USER}" || true
  if sudo test -L "${source_dir}"; then
    echo "${source_dir} is a symlink, refusing to collect" >&2
    return 1
  fi
  if sudo test -d "${source_dir}"; then
    sudo -u "${AGENT_USER}" tar -C "${WORKDIR}" -cf - harbor-jobs | tar -xf -
    find harbor-jobs ! -type f ! -type d -exec rm -f {} +
  fi
}

install_codex() {
  local triple
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) triple=x86_64-unknown-linux-musl ;;
    Linux-aarch64) triple=aarch64-unknown-linux-musl ;;
    Darwin-arm64) triple=aarch64-apple-darwin ;;
    *)
      echo "No Codex binary for $(uname -s) $(uname -m)" >&2
      exit 1
      ;;
  esac
  mkdir -p "${HOME}/.local/bin"
  curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/openai/codex/releases/download/${CODEX_VERSION}/codex-${triple}.tar.gz" | tar -xz -C "${HOME}/.local/bin"
  mv "${HOME}/.local/bin/codex-${triple}" "${HOME}/.local/bin/codex"
}

install_agent() {
  case "${AGENT}" in
    claude-code) curl --proto '=https' --tlsv1.2 -fsSL https://downloads.claude.ai/claude-code-releases/bootstrap.sh | bash ;;
    codex) install_codex ;;
    *)
      echo "Unknown agent '${AGENT}'" >&2
      exit 2
      ;;
  esac
}

install_tools() {
  if [[ -n "${ARTIFACTORY_USER:-}" ]]; then
    export PIP_INDEX_URL="https://${ARTIFACTORY_USER}:${ARTIFACTORY_ACCESS_TOKEN}@repox.jfrog.io/artifactory/api/pypi/sonarsource-pypi/simple"
    export UV_DEFAULT_INDEX="${PIP_INDEX_URL}"
  fi
  python3 -m venv "${HOME}/uv-venv"
  "${HOME}/uv-venv/bin/pip" install --quiet "uv==${UV_VERSION}"
  "${HOME}/uv-venv/bin/uv" tool install --python "${HARBOR_PYTHON_VERSION}" "harbor==${HARBOR_VERSION}"
  curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/SonarSource/sonarqube-cli/master/user-scripts/install.sh | bash
  install_agent
  command -v jq >/dev/null || { echo "jq is required by the task verifiers" >&2; exit 1; }
  install -m 755 "${WORKDIR}/harbor/ci/sonar-wrapper.sh" "${HOME}/.local/bin/sonar"
  echo "sonar CLI: $("${HOME}/.local/share/sonarqube-cli/bin/sonar" --version | tail -n 1)"
}

run_benchmark() {
  local expected_integration prompt_hook file_hook
  local agent_options=()
  case "${AGENT}" in
    claude-code)
      expected_integration=claude-code
      prompt_hook=claude-prompt-submit
      file_hook=claude-pre-tool-use
      export ANTHROPIC_BASE_URL=https://api.portkey.ai
      export ANTHROPIC_AUTH_TOKEN=placeholder-portkey-handles-auth
      export ANTHROPIC_CUSTOM_HEADERS="x-portkey-api-key: ${PORTKEY_API_KEY:?PORTKEY_API_KEY is required}"
      ;;
    codex)
      : "${PORTKEY_API_KEY:?PORTKEY_API_KEY is required}"
      expected_integration=codex
      prompt_hook=codex-prompt-submit
      file_hook=""
      agent_options=(--agent-kwarg dangerously_bypass_hook_trust=true --agent-kwarg "config=${WORKDIR}/harbor/ci/codex-portkey.toml")
      export OPENAI_API_KEY=placeholder-portkey-handles-auth
      ;;
    *)
      echo "Unknown agent '${AGENT}'" >&2
      exit 2
      ;;
  esac
  export PYTHONPATH="${WORKDIR}/harbor/environments"
  cd "${WORKDIR}"
  harbor run \
    --yes \
    --path "${WORKDIR}/harbor/tasks/${TASK}" \
    --ve "EXPECTED_INTEGRATION=${expected_integration}" \
    --ve "PROMPT_HOOK=${prompt_hook}" \
    --ve "FILE_HOOK=${file_hook}" \
    --agent "${AGENT}" \
    ${agent_options[@]+"${agent_options[@]}"} \
    --model "${MODEL}" \
    --jobs-dir "${WORKDIR}/harbor-jobs" \
    --job-name "${JOB_NAME}" \
    --n-concurrent 1 \
    --env host_environment:HostEnvironment
}

main() {
  export HARBOR_HOST_ENVIRONMENT_ALLOW=1
  prepare
  trap collect_results EXIT
  assert_agent_cannot_sudo
  as_agent "${INSTALL_ENV}" bash "${SCRIPT_PATH}" install
  as_agent "${RUN_ENV}" bash "${SCRIPT_PATH}" run
}

case "${1:-}" in
  install) install_tools ;;
  collect) collect_results ;;
  run) run_benchmark ;;
  "") main ;;
  *)
    echo "Usage: run-isolated.sh" >&2
    exit 2
    ;;
esac
