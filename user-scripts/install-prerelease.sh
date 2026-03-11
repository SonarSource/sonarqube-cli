#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$HOME/.local/share/sonarqube-cli/bin"
BINARY_NAME="sonar"
TMP_DIR=""

cleanup() {
  [[ -n "$TMP_DIR" ]] && rm -rf "$TMP_DIR"
}
trap cleanup EXIT

BASE_URL="https://repox.jfrog.io/artifactory/sonarsource-public-builds/org/sonarsource/cli/sonarqube-cli"

detect_platform() {
  local os
  os="$(uname -s)"
  case "$os" in
    Linux*)
      echo "linux-x86-64"
      ;;
    Darwin*)
      echo "macos-arm64"
      ;;
    *)
      echo "Unsupported operating system: $os" >&2
      exit 1
      ;;
  esac
}

fetch_with_auth() {
  local url="$1"
  local token="$2"
  if command -v curl &>/dev/null; then
    curl -fsSL -H "Authorization: Bearer $token" "$url"
  elif command -v wget &>/dev/null; then
    wget -qO- --header="Authorization: Bearer $token" "$url"
  else
    echo "Error: neither curl nor wget is available. Please install one and retry." >&2
    exit 1
  fi
}

download_with_auth() {
  local url="$1"
  local dest="$2"
  local token="$3"
  if command -v curl &>/dev/null; then
    curl -fsSL -H "Authorization: Bearer $token" "$url" -o "$dest"
  elif command -v wget &>/dev/null; then
    wget -qO "$dest" --header="Authorization: Bearer $token" "$url"
  else
    echo "Error: neither curl nor wget is available. Please install one and retry." >&2
    exit 1
  fi
}

resolve_latest_version() {
  local token="$1"
  local api_url="https://repox.jfrog.io/artifactory/api/search/latestVersion?g=org.sonarsource.cli&a=sonarqube-cli&repos=sonarsource-public-builds"
  local version
  version="$(fetch_with_auth "$api_url" "$token" | tr -d '[:space:]')"
  if [[ -z "$version" ]]; then
    echo "Error: could not determine the latest pre-release version." >&2
    exit 1
  fi
  echo "$version"
}

usage() {
  echo "Usage: $0 [--version <version>] [--token <jfrog-token>]"
  echo ""
  echo "Options:"
  echo "  --version   Pre-release version to install (e.g. 0.6.0.424); defaults to latest"
  echo "  --token     JFrog API token (or set ARTIFACTORY_ACCESS_TOKEN env var)"
  exit 1
}

main() {
  local version=""
  local token="${ARTIFACTORY_ACCESS_TOKEN:-}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version)
        version="$2"
        shift 2
        ;;
      --token)
        token="$2"
        shift 2
        ;;
      *)
        echo "Unknown option: $1" >&2
        usage
        ;;
    esac
  done

  if [[ -z "$token" ]]; then
    echo "Error: JFrog token is required. Pass --token or set ARTIFACTORY_ACCESS_TOKEN." >&2
    usage
  fi

  if [[ -z "$version" ]]; then
    echo "Fetching latest pre-release version..."
    version="$(resolve_latest_version "$token")"
  fi

  local platform
  platform="$(detect_platform)"

  local filename="sonarqube-cli-${version}-${platform}.exe"
  local url="$BASE_URL/$version/$filename"
  local dest="$INSTALL_DIR/$BINARY_NAME"
  TMP_DIR="$(mktemp -d -t 'sonarqube-cli-install.XXXXXX')"

  echo "Installing pre-release sonarqube-cli $version"
  echo "Detected platform: $platform"
  echo "Downloading from:"
  echo "  $url"

  mkdir -p "$INSTALL_DIR"

  local tmp_bin="$TMP_DIR/$filename"

  download_with_auth "$url" "$tmp_bin" "$token"

  mv "$tmp_bin" "$dest"
  chmod +x "$dest"

  if [[ "$platform" == macos-* ]]; then
    xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
  fi

  echo "Installed sonar to: $dest"

  local path_line='export PATH="$HOME/.local/share/sonarqube-cli/bin:$PATH"'
  local shell_profiles=()
  [[ -f "$HOME/.bashrc" ]] && shell_profiles+=("$HOME/.bashrc")
  [[ -f "$HOME/.zshrc" ]]  && shell_profiles+=("$HOME/.zshrc")

  if [[ ${#shell_profiles[@]} -eq 0 ]]; then
    echo "No shell profile files found. Add the following line to your shell profile manually:"
    echo "  $path_line"
  else
    for profile in "${shell_profiles[@]}"; do
      if grep -qF 'sonarqube-cli/bin' "$profile" 2>/dev/null; then
        echo "Already present in $profile, skipping."
      else
        printf '\n# Added by sonarqube-cli installer\n%s\n' "$path_line" >> "$profile"
        echo "Updated PATH in: $profile"
      fi
    done
  fi

  echo ""
  echo "Installation complete! (pre-release $version)"
  echo ""
  echo "sonar has been installed to: $dest"
  echo ""
  echo "What happens next:"
  echo "  - Any NEW terminal window you open will have 'sonar' available automatically."
  echo "  - This current terminal window won't see it yet — you have two options:"
  echo ""
  echo "    Option 1: Open a new terminal window (recommended)"
  echo ""
  echo "    Option 2: Activate it in this window right now by running:"
  echo "      export PATH=\"$INSTALL_DIR:\$PATH\""
  echo "      (This only applies to this window — you won't need to run it again.)"
  echo ""
  echo "Once ready, run 'sonar --help' to get started."
}

main "$@"
