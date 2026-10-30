#!/usr/bin/env bash
set -euo pipefail

AGENT_USER=nobody
RUN_ROOT=/usr/local/share/harbor-run
AGENT_HOME="${RUN_ROOT}/home"
WORKDIR="${RUN_ROOT}/work"
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="${WORKDIR}/harbor/scripts/run-isolated.sh"
AGENT_PATH="${AGENT_HOME}/.local/bin:${AGENT_HOME}/.local/share/sonarqube-cli/bin:/usr/local/bin:/usr/bin:/bin"
INSTALL_ENV=ARTIFACTORY_USER,ARTIFACTORY_ACCESS_TOKEN,HARBOR_VERSION,HARBOR_PYTHON_VERSION,UV_VERSION
RUN_ENV=ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL,ANTHROPIC_CUSTOM_HEADERS,MODEL,JOB_NAME,TASK,HB_SONAR_TOKEN,HB_SONAR_ORG,HB_SONAR_SERVER,HB_SONAR_API_URL,HARBOR_HOST_ENVIRONMENT_ALLOW
ROOT_DIR_NAMES=(app logs tests solution)

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
  ls -ld /app /logs /tests /solution
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

install_tools() {
  if [[ -n "${ARTIFACTORY_USER:-}" ]]; then
    export PIP_INDEX_URL="https://${ARTIFACTORY_USER}:${ARTIFACTORY_ACCESS_TOKEN}@repox.jfrog.io/artifactory/api/pypi/sonarsource-pypi/simple"
    export UV_DEFAULT_INDEX="${PIP_INDEX_URL}"
  fi
  python3 -m venv "${HOME}/uv-venv"
  "${HOME}/uv-venv/bin/pip" install --quiet "uv==${UV_VERSION}"
  "${HOME}/uv-venv/bin/uv" tool install --python "${HARBOR_PYTHON_VERSION}" "harbor==${HARBOR_VERSION}"
  curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/SonarSource/sonarqube-cli/master/user-scripts/install.sh | bash
  curl --proto '=https' --tlsv1.2 -fsSL https://downloads.claude.ai/claude-code-releases/bootstrap.sh | bash
  command -v jq >/dev/null || { echo "jq is required by the task verifiers" >&2; exit 1; }
  install -m 755 "${WORKDIR}/harbor/ci/sonar-wrapper.sh" "${HOME}/.local/bin/sonar"
  echo "sonar CLI: $("${HOME}/.local/share/sonarqube-cli/bin/sonar" --version | tail -n 1)"
}

run_benchmark() {
  export PYTHONPATH="${WORKDIR}/harbor/environments"
  cd "${WORKDIR}"
  harbor run \
    --yes \
    --path "${WORKDIR}/harbor/tasks/${TASK}" \
    --ve EXPECTED_INTEGRATION=claude-code \
    --ve PROMPT_HOOK=claude-prompt-submit \
    --ve FILE_HOOK=claude-pre-tool-use \
    --agent claude-code \
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
