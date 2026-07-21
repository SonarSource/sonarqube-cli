#!/usr/bin/env bash
# Ensures the MDM binary is present, then updates it to the latest version.
# Downloads directly -- no sonar self-update, no external script fetches.
# SONARQUBE_CLI_FORCE            -- optional JumpCloud variable; set to "true" to replace even when already at latest.
# SONARQUBE_CLI_APPROVED_VERSION  -- optional JumpCloud variable; pins the update version instead of
#                      using stable.version.
set -euo pipefail

MDM_BINARY="/usr/local/bin/sonar"
readonly ARTIFACT_BASE_URL="https://binaries.sonarsource.com/Distribution/sonarqube-cli"
# JumpCloud-specific: {{SONARQUBE_CLI_FORCE}} / {{SONARQUBE_CLI_APPROVED_VERSION}} are replaced with
# the Custom Variable's value (quoted) at runtime -- not real environment variables. Other MDM
# systems may inject this differently.
APPROVED_VERSION_OVERRIDE={{SONARQUBE_CLI_APPROVED_VERSION}}
[[ "$APPROVED_VERSION_OVERRIDE" == \{\{*\}\} ]] && APPROVED_VERSION_OVERRIDE=""  # defensive: unattached JumpCloud var may leave the literal placeholder
FORCE={{SONARQUBE_CLI_FORCE}}
readonly HTTPS_ONLY="=https"
export PATH="/usr/local/bin:$PATH"

# -- Platform helpers ----------------------------------------------------------

cdn_os() { echo "linux"; }

cdn_platform() {
    case "$(uname -m)" in
        aarch64|arm64) echo "linux-arm64" ;;
        x86_64|amd64)  echo "linux-x86-64" ;;
        *)             echo "" ;;
    esac
}

# -- SHA256 helpers ------------------------------------------------------------

sha256_of() {
    local file="$1"
    sha256sum "$file" | awk '{print $1}'
}

verify_sha256() {
    local binary="$1" version="$2"
    local platform os base url expected actual
    platform="$(cdn_platform)"
    os="$(cdn_os)"
    if [[ -z "$platform" || -z "$os" ]]; then
        echo "Warning: unsupported platform -- skipping SHA256 check." >&2
        return
    fi
    base="sonarqube-cli-${version}-${platform}"
    url="${ARTIFACT_BASE_URL}/${version}/${os}/${base}.bin.sha256"
    expected="$(curl -fsSL --proto "$HTTPS_ONLY" --proto-redir "$HTTPS_ONLY" "$url" 2>/dev/null | awk '{print $1}')"
    if [[ -z "$expected" ]]; then
        echo "Error: could not fetch SHA256 from $url -- aborting." >&2
        exit 1
    fi
    actual="$(sha256_of "$binary")"
    if [[ "$actual" != "$expected" ]]; then
        echo "Error: SHA256 mismatch for $binary" >&2
        echo "  expected: $expected" >&2
        echo "  actual:   $actual" >&2
        exit 1
    fi
    echo "SHA256 verified: $binary ($version)"
}

# -- Binary download -----------------------------------------------------------

download_binary() {
    local version="$1" dest="$2"
    local platform os base url_bin url_exe tmp_bin
    platform="$(cdn_platform)"
    os="$(cdn_os)"
    if [[ -z "$platform" || -z "$os" ]]; then
        echo "Error: unsupported platform." >&2; exit 1
    fi
    base="sonarqube-cli-${version}-${platform}"
    url_bin="${ARTIFACT_BASE_URL}/${version}/${os}/${base}.bin"
    url_exe="${ARTIFACT_BASE_URL}/${version}/${os}/${base}.exe"
    tmp_bin="$(mktemp /tmp/sonar-bin.XXXXXX)"
    trap 'rm -f "$tmp_bin"' EXIT
    echo "Downloading sonarqube-cli from:"
    if curl -fsSL --proto "$HTTPS_ONLY" --proto-redir "$HTTPS_ONLY" "$url_bin" -o "$tmp_bin" 2>/dev/null; then
        echo "  $url_bin"
    elif curl -fsSL --proto "$HTTPS_ONLY" --proto-redir "$HTTPS_ONLY" "$url_exe" -o "$tmp_bin" 2>/dev/null; then
        echo "  $url_exe"
    else
        echo "Error: could not download sonarqube-cli." >&2; rm -f "$tmp_bin"; exit 1
    fi
    chmod +x "$tmp_bin"
    verify_sha256 "$tmp_bin" "$version"
    trap - EXIT
    mv "$tmp_bin" "$dest"
}

# -- Main ----------------------------------------------------------------------

if [[ -n "$APPROVED_VERSION_OVERRIDE" ]]; then
    target_version="$APPROVED_VERSION_OVERRIDE"
else
    target_version="$(curl -fsSL --proto "$HTTPS_ONLY" --proto-redir "$HTTPS_ONLY" "${ARTIFACT_BASE_URL}/stable.version" | tr -d '[:space:]')"
fi
echo "Target version: $target_version"

target_semver="$(echo "$target_version" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')"

if [[ -f "$MDM_BINARY" ]]; then
    installed_semver="$("$MDM_BINARY" --version 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' || true)"
    if [[ "${FORCE:-}" != "true" && "$installed_semver" == "$target_semver" ]]; then
        echo "Already at version $target_version, nothing to do."
        exit 0
    fi
    echo "Updating $installed_semver -> $target_semver..."
else
    echo "MDM binary not found -- installing first..."
    mkdir -p "$(dirname "$MDM_BINARY")"
fi

download_binary "$target_version" "$MDM_BINARY"

echo "MDM sonar: $MDM_BINARY -- $("$MDM_BINARY" --version)"
echo "which sonar: $(which sonar)"
echo "sonar -v:    $(sonar --version)"
