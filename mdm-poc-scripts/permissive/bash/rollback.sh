#!/usr/bin/env bash
# JumpCloud Command: IS > Prod > Mac + Linux > Rollback SonarQube CLI
# Downloads ROLLBACK_VERSION directly -- no sonar self-update, no external script fetches.
# Set ROLLBACK_VERSION via JumpCloud variable injection, e.g. ROLLBACK_VERSION="1.1.0.3122".
# ARTIFACT_BASE_URL -- optional JumpCloud variable; overrides the binary download source.
set -euo pipefail

MDM_BINARY="/usr/local/bin/sonar"
ARTIFACT_BASE_URL="${ARTIFACT_BASE_URL:-https://binaries.sonarsource.com/Distribution/sonarqube-cli}"
readonly HTTPS_ONLY="=https"
: "${ROLLBACK_VERSION:?ROLLBACK_VERSION must be set via JumpCloud variable injection}"

# ── SHA256 helpers ────────────────────────────────────────────────────────────

sha256_of() {
    local file="$1"
    case "$(uname -s)" in
        Darwin) shasum -a 256 "$file" | awk '{print $1}' ;;
        Linux)  sha256sum "$file" | awk '{print $1}' ;;
        *)      echo "" ;;
    esac
}

cdn_os() {
    case "$(uname -s)" in Darwin) echo "macos" ;; Linux) echo "linux" ;; *) echo "" ;; esac
}

cdn_platform() {
    case "$(uname -s)/$(uname -m)" in
        Darwin/arm64)              echo "macos-arm64" ;;
        Darwin/x86_64)             echo "macos-x86-64" ;;
        Linux/aarch64|Linux/arm64) echo "linux-arm64" ;;
        Linux/x86_64|Linux/amd64)  echo "linux-x86-64" ;;
        *)                         echo "" ;;
    esac
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
        echo "Warning: could not fetch SHA256 from $url -- skipping integrity check." >&2
        return
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
    trap "rm -f $tmp_bin" EXIT
    echo "Downloading sonarqube-cli from:"
    if curl -fsSL --proto "$HTTPS_ONLY" --proto-redir "$HTTPS_ONLY" "$url_bin" -o "$tmp_bin" 2>/dev/null; then
        echo "  $url_bin"
    elif curl -fsSL --proto "$HTTPS_ONLY" --proto-redir "$HTTPS_ONLY" "$url_exe" -o "$tmp_bin" 2>/dev/null; then
        echo "  $url_exe"
    else
        echo "Error: could not download sonarqube-cli." >&2; rm -f "$tmp_bin"; exit 1
    fi
    chmod +x "$tmp_bin"
    [[ "$platform" == macos-* ]] && xattr -d com.apple.quarantine "$tmp_bin" 2>/dev/null || true
    mv "$tmp_bin" "$dest"
}

# -- Main ----------------------------------------------------------------------

echo "Rolling back to version $ROLLBACK_VERSION..."
mkdir -p "$(dirname "$MDM_BINARY")"
download_binary "$ROLLBACK_VERSION" "$MDM_BINARY"
verify_sha256 "$MDM_BINARY" "$ROLLBACK_VERSION"
echo "MDM sonar: $MDM_BINARY -- $("$MDM_BINARY" --version)"
