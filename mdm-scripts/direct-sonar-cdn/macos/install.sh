#!/usr/bin/env bash
# 1. Always installs the latest CLI to /usr/local/bin/sonar.
# 2. For every local user that has a standalone install, replaces it with a
#    symlink to the MDM binary so PATH order cannot override it.
# Self-contained: no external scripts are downloaded or executed.
# SONARQUBE_CLI_APPROVED_VERSION -- optional JumpCloud variable; pins the install version instead of
#                     using stable.version.
set -euo pipefail

MDM_BINARY="/usr/local/bin/sonar"
STANDALONE_REL=".local/share/sonarqube-cli/bin/sonar"
readonly ARTIFACT_BASE_URL="https://binaries.sonarsource.com/Distribution/sonarqube-cli"
# JumpCloud-specific: {{SONARQUBE_CLI_APPROVED_VERSION}} is replaced with the Custom Variable's
# value (quoted) at runtime -- not a real environment variable. Other MDM systems may inject this
# differently.
APPROVED_VERSION_OVERRIDE={{SONARQUBE_CLI_APPROVED_VERSION}}
[[ "$APPROVED_VERSION_OVERRIDE" == \{\{*\}\} ]] && APPROVED_VERSION_OVERRIDE=""  # defensive: unattached JumpCloud var may leave the literal placeholder
# Defense-in-depth: a valid version can't contain quotes/$()/backticks, so this closes off
# variable-substitution injection regardless of how the MDM tool quotes Custom Variables.
[[ -z "$APPROVED_VERSION_OVERRIDE" || "$APPROVED_VERSION_OVERRIDE" =~ ^[0-9][0-9.]*$ ]] || { echo "Error: SONARQUBE_CLI_APPROVED_VERSION has an invalid format: $APPROVED_VERSION_OVERRIDE" >&2; exit 1; }
readonly HTTPS_ONLY="=https"
export PATH="/usr/local/bin:$PATH"

# ── Platform helpers ──────────────────────────────────────────────────────────

cdn_os() { echo "macos"; }

cdn_platform() {
    case "$(uname -m)" in
        arm64)  echo "macos-arm64" ;;
        x86_64) echo "macos-x86-64" ;;
        *)      echo "" ;;
    esac
}

# ── SHA256 helpers ────────────────────────────────────────────────────────────

sha256_of() {
    local file="$1"
    shasum -a 256 "$file" | awk '{print $1}'
}

verify_sha256() {
    local binary="$1" version="$2"
    local platform os base url expected actual
    platform="$(cdn_platform)"
    os="$(cdn_os)"
    if [[ -z "$platform" || -z "$os" ]]; then
        echo "Warning: unsupported platform — skipping SHA256 check." >&2
        return
    fi
    base="sonarqube-cli-${version}-${platform}"
    url="${ARTIFACT_BASE_URL}/${version}/${os}/${base}.bin.sha256"
    expected="$(curl -fsSL --proto "$HTTPS_ONLY" --proto-redir "$HTTPS_ONLY" "$url" 2>/dev/null | awk '{print $1}')"
    if [[ -z "$expected" ]]; then
        echo "Error: could not fetch SHA256 from $url — aborting." >&2
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

# ── Binary download ───────────────────────────────────────────────────────────

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
    [[ "$platform" == macos-* ]] && xattr -d com.apple.quarantine "$tmp_bin" 2>/dev/null || true
    verify_sha256 "$tmp_bin" "$version"
    trap - EXIT
    mv "$tmp_bin" "$dest"
}

# ── Step 1: install MDM binary ───────────────────────────────────────────────

echo "Installing SonarQube CLI to $MDM_BINARY..."

if [[ -n "$APPROVED_VERSION_OVERRIDE" ]]; then
    version="$APPROVED_VERSION_OVERRIDE"
else
    version="$(curl -fsSL --proto "$HTTPS_ONLY" --proto-redir "$HTTPS_ONLY" "${ARTIFACT_BASE_URL}/stable.version" | tr -d '[:space:]')"
fi
echo "Target version: $version"

mkdir -p "$(dirname "$MDM_BINARY")"
download_binary "$version" "$MDM_BINARY"

# ── Step 2: enumerate local user home directories ────────────────────────────

get_user_homes() {
    dscl . list /Users NFSHomeDirectory \
        | awk '$1 !~ /^_/ && $2 ~ /^\/Users\// { print $2 }'
}

# ── Step 3: symlink standalone path → MDM binary for each user ───────────────

while IFS= read -r home; do
    standalone="$home/$STANDALONE_REL"
    [[ -e "$standalone" || -L "$standalone" ]] || continue

    if [[ -L "$standalone" && "$(readlink "$standalone")" == "$MDM_BINARY" ]]; then
        echo "  $standalone — already symlinked, skipping"
        continue
    fi

    echo "  $standalone — replacing with symlink to $MDM_BINARY"
    ln -sf "$MDM_BINARY" "$standalone"
done < <(get_user_homes)

# ── Verify ───────────────────────────────────────────────────────────────────

echo "MDM sonar: $MDM_BINARY — $("$MDM_BINARY" --version)"
echo "which sonar: $(which sonar)"
echo "sonar -v:    $(sonar --version)"
