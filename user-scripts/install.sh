#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="$HOME/.local/share/sonarqube-cli/bin"
BINARY_NAME="sonar"

BASE_URL="https://binaries.sonarsource.com/CommercialDistribution/sonar-secrets"

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

verify_sha256() {
  local file="$1"
  local checksum_file="$2"
  # The .sha256 file typically contains just the hex digest, or "hash  filename"
  local expected
  expected="$(awk '{print $1}' "$checksum_file")"

  local actual
  if command -v sha256sum &>/dev/null; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif command -v shasum &>/dev/null; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  else
    echo "Warning: no SHA256 tool found (sha256sum or shasum). Skipping checksum verification." >&2
    return 0
  fi

  if [[ "$actual" != "$expected" ]]; then
    echo "Error: SHA256 checksum mismatch!" >&2
    echo "  Expected: $expected" >&2
    echo "  Actual:   $actual" >&2
    return 1
  fi

  echo "SHA256 checksum verified."
}

main() {
  local platform
  platform="$(detect_platform)"

  local version
  echo "Fetching latest version..."
  version="$(resolve_latest_version)"
  echo "Latest version: $version"

  local filename="sonar-secrets-${version}-${platform}.exe"
  local url="$BASE_URL/$filename"
  local checksum_url="${url}.sha256"
  local dest="$INSTALL_DIR/$BINARY_NAME"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  echo "Detected platform: $platform"
  echo "Downloading sonar-secrets from:"
  echo "  $url"

  mkdir -p "$INSTALL_DIR"

  local tmp_bin="$tmp_dir/$filename"
  local tmp_checksum="$tmp_dir/$filename.sha256"

  download "$url" "$tmp_bin"
  echo "Downloading SHA256 checksum from:"
  echo "  $checksum_url"
  download "$checksum_url" "$tmp_checksum"

  verify_sha256 "$tmp_bin" "$tmp_checksum"

  mv "$tmp_bin" "$dest"
  chmod +x "$dest"
  echo "Installed sonar to: $dest"

  local path_line='export PATH="$HOME/.local/share/sonarqube-cli/bin:$PATH"'

  echo ""
  echo "To run 'sonar' from anywhere, $INSTALL_DIR needs to be on your PATH."
  echo "The installer can add it automatically to your shell profile (.bashrc / .zshrc)."
  printf "Would you like to do that now? [y/N] "
  local answer
  read -r answer

  if [[ "${answer,,}" == "y" ]]; then
    local shell_profiles=()
    [[ -f "$HOME/.bashrc" ]] && shell_profiles+=("$HOME/.bashrc")
    [[ -f "$HOME/.zshrc" ]]  && shell_profiles+=("$HOME/.zshrc")

    if [[ ${#shell_profiles[@]} -eq 0 ]]; then
      echo "No shell profile files found. Add the following line manually:"
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
  else
    echo "Skipped. To add it manually, append the following to your shell profile:"
    echo "  $path_line"
  fi

  echo ""
  echo "Installation complete."
  echo "To use 'sonar' in your current session, run:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
}

main "$@"
