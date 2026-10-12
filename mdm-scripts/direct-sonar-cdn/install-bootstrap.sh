#!/usr/bin/env bash
# Installs the CLI system-wide and replaces per-user standalone installs with symlinks to it.
# SONARQUBE_CLI_APPROVED_VERSION -- optional JumpCloud variable; pins the install version instead of using stable.version.
# SONARQUBE_CLI_ARTIFACT_BASE_URL -- optional JumpCloud variable; overrides the download source.
# Runs `sonar mdm <action>`; when the installed CLI predates `sonar mdm` (or is missing), a verified
# copy of the stable release is downloaded and used to run the action instead.
set -euo pipefail

MDM_BINARY="/usr/local/bin/sonar"
DEFAULT_ARTIFACT_BASE_URL="https://binaries.sonarsource.com/Distribution/sonarqube-cli"
# JumpCloud-specific: {{VAR}} placeholders below are replaced with the Custom Variable's value (quoted)
# at runtime -- not real environment variables. Other MDM systems may inject this differently.
APPROVED_VERSION={{SONARQUBE_CLI_APPROVED_VERSION}}
[[ "$APPROVED_VERSION" == \{\{*\}\} ]] && APPROVED_VERSION=""
[[ -z "$APPROVED_VERSION" || "$APPROVED_VERSION" =~ ^[0-9][0-9.]*$ ]] || { echo "Error: SONARQUBE_CLI_APPROVED_VERSION has an invalid format: $APPROVED_VERSION" >&2; exit 1; }
ARTIFACT_BASE_URL_OVERRIDE={{SONARQUBE_CLI_ARTIFACT_BASE_URL}}
[[ "$ARTIFACT_BASE_URL_OVERRIDE" == \{\{*\}\} ]] && ARTIFACT_BASE_URL_OVERRIDE=""
ARTIFACT_BASE_URL="${ARTIFACT_BASE_URL_OVERRIDE:-$DEFAULT_ARTIFACT_BASE_URL}"
ARTIFACT_BASE_URL="${ARTIFACT_BASE_URL%/}"
URL_CHARS="[A-Za-z0-9._~:/?#@!&'()*+,;=%-]+"
LOOPBACK_HTTP_PATTERN="^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?/$URL_CHARS$"
FETCH_PROTOCOLS='=https'
if [[ "$ARTIFACT_BASE_URL" =~ $LOOPBACK_HTTP_PATTERN ]]; then
    FETCH_PROTOCOLS='=http,https'
elif ! [[ "$ARTIFACT_BASE_URL" =~ ^https://$URL_CHARS$ ]]; then
    echo "Error: SONARQUBE_CLI_ARTIFACT_BASE_URL must be an https:// URL: $ARTIFACT_BASE_URL" >&2; exit 1
fi

ALLOW_MISSING_CHECKSUM=false
STABLE_VERSION_PATTERN='^[0-9][0-9.]*$'
RUNNER=""
WORK_DIR=""
trap '[[ -n "$WORK_DIR" ]] && rm -rf "$WORK_DIR"' EXIT

fetch() { curl -fsSL --proto "$FETCH_PROTOCOLS" --proto-redir "$FETCH_PROTOCOLS" "$@"; }

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
    else shasum -a 256 "$1" | awk '{print $1}'
    fi
}

resolve_stable_version() {
    local stable
    stable="$(fetch "$ARTIFACT_BASE_URL/stable.version" | tr -d '[:space:]')"
    [[ "$stable" =~ $STABLE_VERSION_PATTERN ]] || { echo "Error: could not determine a valid stable version: $stable" >&2; exit 1; }
    echo "$stable"
}

download_runner() {
    local version="$1" os arch artifact url expected actual extension
    case "$(uname -s)" in
        Darwin) os="macos" ;;
        Linux)  os="linux" ;;
        *)      echo "Error: unsupported OS: $(uname -s)" >&2; exit 1 ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) arch="arm64" ;;
        x86_64|amd64)  arch="x86-64" ;;
        *)             echo "Error: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    WORK_DIR="$(mktemp -d)"
    RUNNER="$WORK_DIR/sonar"
    artifact="$ARTIFACT_BASE_URL/$version/$os/sonarqube-cli-$version-$os-$arch"
    url=""
    for extension in bin exe; do
        if fetch "$artifact.$extension" -o "$RUNNER" 2>/dev/null; then url="$artifact.$extension"; break; fi
    done
    [[ -n "$url" ]] || { echo "Error: could not download $artifact.{bin,exe}" >&2; exit 1; }
    expected="$(fetch "$url.sha256" 2>/dev/null | awk '{print $1}' || true)"
    if [[ -z "$expected" ]]; then
        [[ "$ALLOW_MISSING_CHECKSUM" == "true" ]] || { echo "Error: could not fetch SHA256 from $url.sha256 -- aborting." >&2; exit 1; }
        echo "Warning: could not fetch SHA256 from $url.sha256 -- skipping integrity check." >&2
    else
        actual="$(sha256_of "$RUNNER")"
        [[ "$actual" == "$expected" ]] || { echo "Error: SHA256 mismatch (expected $expected, actual $actual)" >&2; exit 1; }
        echo "SHA256 verified ($version)"
    fi
    chmod 755 "$RUNNER"
    if [[ "$os" == "macos" ]]; then xattr -d com.apple.quarantine "$RUNNER" 2>/dev/null || true; fi
}

select_runner() {
    if [[ -x "$MDM_BINARY" ]] && "$MDM_BINARY" mdm --help >/dev/null 2>&1; then
        RUNNER="$MDM_BINARY"
    else
        echo "Installed CLI is missing or does not support 'sonar mdm' -- using the stable release."
        download_runner "$(resolve_stable_version)"
    fi
}

run_mdm_action() {
    "$RUNNER" mdm "$@"
}

version="${APPROVED_VERSION:-$(resolve_stable_version)}"
echo "Target version: $version"
download_runner "$version"
install_args=(--approved-version "$version" --artifact-base-url "$ARTIFACT_BASE_URL")
run_mdm_action install "${install_args[@]}"
