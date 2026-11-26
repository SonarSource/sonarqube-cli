#!/usr/bin/env bash
set -euo pipefail

AGENT_USER=nobody
RUN_ROOT=/usr/local/share/harbor-run
AGENT_HOME="${RUN_ROOT}/home"
WORKDIR="${RUN_ROOT}/work"
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_PATH="${WORKDIR}/harbor/scripts/run-isolated.sh"
AGENT_PATH="${AGENT_HOME}/.local/bin:${AGENT_HOME}/.local/share/sonarqube-cli/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
INSTALL_ENV=ARTIFACTORY_USER,ARTIFACTORY_ACCESS_TOKEN,HARBOR_VERSION,HARBOR_PYTHON_VERSION,UV_VERSION,AGENT,CODEX_VERSION,AGENT_PLUGIN,AGENT_PLUGIN_REF
RUN_ENV=AGENT,MODEL,JOB_NAME,TASK,HB_SONAR_TOKEN,HB_SONAR_ORG,HB_SONAR_SERVER,HB_SONAR_API_URL,HB_AGENT_PLUGIN_DIR,HB_AGENT_PLUGIN_REF,HARBOR_HOST_ENVIRONMENT_ALLOW
AGENT_PLUGIN_REPO=https://github.com/SonarSource/sonarqube-agent-plugins.git
AGENT_PLUGIN_DIR="${AGENT_HOME}/sonarqube-agent-plugins"
ROOT_DIR_NAMES=(app logs tests solution installed-agent)
PORTKEY_PROXY_PORT=8787
PORTKEY_PROXY_PID=

as_agent() {
  local preserved_env="$1"
  shift
  (cd "${AGENT_HOME}" && sudo --preserve-env="${preserved_env}" -u "${AGENT_USER}" -H env HOME="${AGENT_HOME}" PATH="${AGENT_PATH}" "$@")
}

create_root_dirs() {
  for name in "${ROOT_DIR_NAMES[@]}"; do
    sudo mkdir -p "/${name}"
    sudo chown "${AGENT_USER}" "/${name}"
  done
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

install_agent_plugin() {
  [[ "${AGENT_PLUGIN}" == with ]] || return 0
  git clone --quiet --depth 1 --branch "${AGENT_PLUGIN_REF}" "${AGENT_PLUGIN_REPO}" "${AGENT_PLUGIN_DIR}"
  echo "SonarQube agent plugin: ${AGENT_PLUGIN_REF} ($(git -C "${AGENT_PLUGIN_DIR}" rev-parse --short HEAD))"
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
  install_agent_plugin
  command -v jq >/dev/null || { echo "jq is required by the task verifiers" >&2; exit 1; }
  install -m 755 "${WORKDIR}/harbor/ci/sonar-wrapper.sh" "${HOME}/.local/bin/sonar"
  echo "sonar CLI: $("${HOME}/.local/share/sonarqube-cli/bin/sonar" --version | tail -n 1)"
}

codex_config() {
  local base="${WORKDIR}/harbor/ci/codex-portkey.toml"
  if [[ -z "${HB_AGENT_PLUGIN_DIR:-}" ]]; then
    echo "${base}"
    return
  fi
  local config="${WORKDIR}/codex-config.toml"
  # Harbor writes this file over $CODEX_HOME/config.toml, which drops what `codex plugin add` wrote there.
  {
    cat "${base}"
    printf '\n[marketplaces.sonar]\nsource_type = "local"\nsource = "%s"\n' "${HB_AGENT_PLUGIN_DIR}"
    printf '\n[plugins."sonarqube@sonar"]\nenabled = true\n'
  } > "${config}"
  echo "${config}"
}

run_benchmark() {
  local expected_integration prompt_hook file_hook
  local agent_options=()
  case "${AGENT}" in
    claude-code)
      expected_integration=claude-code
      prompt_hook=claude-prompt-submit
      file_hook=claude-pre-tool-use
      export ANTHROPIC_BASE_URL="http://127.0.0.1:${PORTKEY_PROXY_PORT}"
      export ANTHROPIC_AUTH_TOKEN=placeholder-portkey-handles-auth
      ;;
    codex)
      expected_integration=codex
      prompt_hook=codex-prompt-submit
      file_hook=""
      agent_options=(--agent-kwarg dangerously_bypass_hook_trust=true --agent-kwarg "config=$(codex_config)")
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

start_portkey_proxy() {
  if (echo > "/dev/tcp/127.0.0.1/${PORTKEY_PROXY_PORT}") 2>/dev/null; then
    echo "Port ${PORTKEY_PROXY_PORT} is already in use, the Portkey proxy cannot start" >&2
    exit 1
  fi
  python3 -I "${SOURCE_ROOT}/scripts/portkey-proxy.py" --port "${PORTKEY_PROXY_PORT}" &
  PORTKEY_PROXY_PID=$!
  for _ in $(seq 50); do
    if (echo > "/dev/tcp/127.0.0.1/${PORTKEY_PROXY_PORT}") 2>/dev/null && kill -0 "${PORTKEY_PROXY_PID}" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  echo "The Portkey proxy did not start on port ${PORTKEY_PROXY_PORT}" >&2
  exit 1
}

mint_sonar_run_token() {
  local created
  created="$(python3 -I "${SOURCE_ROOT}/scripts/sonar-run-token.py" create --name "harbor-${JOB_NAME}-${TASK}-$(python3 -I -c 'import uuid; print(uuid.uuid4().hex[:12])')")"
  SONAR_RUN_TOKEN_ID="$(jq -r .id <<<"${created}")"
  HB_SONAR_TOKEN="$(jq -r .token <<<"${created}")"
  export HB_SONAR_TOKEN
  (umask 077 && printf '%s' "${SONAR_RUN_TOKEN_ID}" >"${SONAR_RUN_TOKEN_ID_FILE}")
}

revoke_sonar_run_token() {
  [[ -s "${SONAR_RUN_TOKEN_ID_FILE}" ]] || { echo "No run token id was recorded, so there is no token to revoke" >&2; exit 1; }
  python3 -I "${SOURCE_ROOT}/scripts/sonar-run-token.py" delete --id "$(cat "${SONAR_RUN_TOKEN_ID_FILE}")"
}

stop_and_collect() {
  kill "${PORTKEY_PROXY_PID}" 2>/dev/null || true
  collect_results
}

select_agent_plugin() {
  export AGENT_PLUGIN="${AGENT_PLUGIN:-without}" HB_AGENT_PLUGIN_DIR= HB_AGENT_PLUGIN_REF=
  case "${AGENT_PLUGIN}" in
    without) ;;
    with)
      : "${AGENT_PLUGIN_REF:?AGENT_PLUGIN_REF must be set to install the agent plugin}"
      HB_AGENT_PLUGIN_DIR="${AGENT_PLUGIN_DIR}"
      HB_AGENT_PLUGIN_REF="${AGENT_PLUGIN_REF}"
      ;;
    *)
      echo "AGENT_PLUGIN must be 'with' or 'without', got '${AGENT_PLUGIN}'" >&2
      exit 2
      ;;
  esac
}

main() {
  : "${SONAR_RUN_TOKEN_ID_FILE:?SONAR_RUN_TOKEN_ID_FILE must be set}"
  export HARBOR_HOST_ENVIRONMENT_ALLOW=1
  select_agent_plugin
  prepare
  trap stop_and_collect EXIT
  assert_agent_cannot_sudo
  as_agent "${INSTALL_ENV}" bash "${SCRIPT_PATH}" install
  start_portkey_proxy
  mint_sonar_run_token
  as_agent "${RUN_ENV}" bash "${SCRIPT_PATH}" run
}

case "${1:-}" in
  install) install_tools ;;
  collect) collect_results ;;
  run) run_benchmark ;;
  revoke) revoke_sonar_run_token ;;
  "") main ;;
  *)
    echo "Usage: run-isolated.sh" >&2
    exit 2
    ;;
esac
