#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$HOME/.local/share/sonarqube-cli/bin"
BINARY_NAME="sonar"
TMP_DIR=""

cleanup() {
  [[ -n "$TMP_DIR" ]] && rm -rf "$TMP_DIR"
}
trap cleanup EXIT

BASE_URL="https://binaries.sonarsource.com/Distribution/sonarqube-cli"

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

resolve_latest_version() {
  local version
  if command -v curl &>/dev/null; then
    version="$(curl -fsSL "$BASE_URL/latest-version.txt")"
  elif command -v wget &>/dev/null; then
    version="$(wget -qO- "$BASE_URL/latest-version.txt")"
  else
    echo "Error: neither curl nor wget is available. Please install one and retry." >&2
    exit 1
  fi

  version="$(printf '%s' "$version" | tr -d '[:space:]')"
  if [[ -z "$version" ]]; then
    echo "Error: could not determine the latest version." >&2
    exit 1
  fi

  echo "$version"
}

download() {
  local url="$1"
  local dest="$2"
  if command -v curl &>/dev/null; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget &>/dev/null; then
    wget -qO "$dest" "$url"
  else
    echo "Error: neither curl nor wget is available. Please install one and retry." >&2
    exit 1
  fi
}


main() {
  local platform
  platform="$(detect_platform)"

  local version
  #echo "Fetching latest version..."
  #version="$(resolve_latest_version)"
  version="0.3.0.243"
  echo "Latest version: $version"

  local filename="sonarqube-cli-${version}-${platform}.exe"
  local url="$BASE_URL/$filename"
  local dest="$INSTALL_DIR/$BINARY_NAME"
  TMP_DIR="$(mktemp -d)"

  echo "Detected platform: $platform"
  echo "Downloading sonarqube-cli from:"
  echo "  $url"

  mkdir -p "$INSTALL_DIR"

  local tmp_bin="$TMP_DIR/$filename"

  download "$url" "$tmp_bin"

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
  echo "Installation complete."
  echo "To use 'sonar' in your current session, run:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
}

main "$@"
