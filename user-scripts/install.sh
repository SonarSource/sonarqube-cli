#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR=""
BINARY_NAME="sonar"
TMP_DIR=""

cleanup() {
  [[ -n "$TMP_DIR" ]] && rm -rf "$TMP_DIR"
}
trap cleanup EXIT

BASE_URL="https://binaries.sonarsource.com/Distribution/sonarqube-cli"
# Older self-update implementations scrape a literal `version="..."` from this
# file before executing it. Keep this compatibility marker present, but unused:
# the real version now comes from stable.version at runtime. Release automation
# keeps this marker aligned with the latest released CLI version.
version="1.2.0.3278"

detect_os() {
  local os
  os="$(uname -s)"
  case "$os" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    *)
      echo "Unsupported operating system: $os" >&2
      exit 1
      ;;
  esac
}

detect_platform() {
  case "$(detect_os)" in
    linux)
      case "$(uname -m)" in
        aarch64 | arm64) echo "linux-arm64" ;;
        x86_64 | amd64) echo "linux-x86-64" ;;
        *)
          echo "Unsupported Linux architecture: $(uname -m)" >&2
          exit 1
          ;;
      esac
      ;;
    macos) echo "macos-arm64" ;;
  esac
}

resolve_latest_version() {
  local version
  if command -v curl &>/dev/null; then
    version="$(curl -fsSL "$BASE_URL/stable.version")"
  elif command -v wget &>/dev/null; then
    version="$(wget -qO- "$BASE_URL/stable.version")"
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

# Optional third argument "quiet": return 1 on failure instead of exiting (stderr suppressed).
download() {
  local url="$1"
  local dest="$2"
  local quiet="${3:-}"
  if command -v curl &>/dev/null; then
    if [[ -n "$quiet" ]]; then
      curl -fsSL "$url" -o "$dest" 2>/dev/null
    else
      curl -fsSL "$url" -o "$dest"
    fi
    return
  fi
  if command -v wget &>/dev/null; then
    if [[ -n "$quiet" ]]; then
      wget -qO "$dest" "$url" 2>/dev/null
    else
      wget -qO "$dest" "$url"
    fi
    return
  fi
  if [[ -n "$quiet" ]]; then
    return 1
  fi
  echo "Error: neither curl nor wget is available. Please install one and retry." >&2
  exit 1
}

# Fetches the CLI from binaries.sonarsource.com (sonar self-update runs this script from GitHub).
# Tries .bin first, then .exe for legacy CDN builds. Remove .exe fallback once .bin is released.
download_cli_artifact() {
  local version="$1"
  local platform="$2"
  local os="$3"
  local dest="$4"
  local dist_prefix=""
  [[ "$DISTRIBUTION" != "standalone" ]] && dist_prefix="${DISTRIBUTION}-"
  local base="sonarqube-cli-${version}-${dist_prefix}${platform}"
  local url_bin="$BASE_URL/$version/$os/${base}.bin"
  local url_exe="$BASE_URL/$version/$os/${base}.exe"

  if download "$url_bin" "$dest" quiet; then
    echo "  $url_bin"
    return 0
  fi
  if download "$url_exe" "$dest" quiet; then
    echo "  $url_exe"
    return 0
  fi

  echo "Error: could not download sonarqube-cli (tried .bin and .exe):" >&2
  echo "  $url_bin" >&2
  echo "  $url_exe" >&2
  exit 1
}

# Detect the best shell profile file to update (inspired by nvm_detect_profile).
# Honors $PROFILE override, detects shell from $SHELL, respects $ZDOTDIR for zsh.
# Outputs exactly one file path, or nothing if no profile is found.
detect_profile() {
  if [[ "${PROFILE:-}" == "/dev/null" ]]; then
    return
  fi
  if [[ -n "${PROFILE:-}" && -f "$PROFILE" ]]; then
    echo "$PROFILE"
    return
  fi

  local detected=""
  case "${SHELL+${SHELL##*/}}" in
    bash)
      if [[ -f "$HOME/.bashrc" ]]; then
        detected="$HOME/.bashrc"
      elif [[ -f "$HOME/.bash_profile" ]]; then
        detected="$HOME/.bash_profile"
      fi
      ;;
    zsh)
      if [[ -f "${ZDOTDIR:-$HOME}/.zshrc" ]]; then
        detected="${ZDOTDIR:-$HOME}/.zshrc"
      elif [[ -f "${ZDOTDIR:-$HOME}/.zprofile" ]]; then
        detected="${ZDOTDIR:-$HOME}/.zprofile"
      fi
      ;;
  esac

  if [[ -z "$detected" ]]; then
    for f in ".profile" ".bashrc" ".bash_profile" ".zprofile" ".zshrc"; do
      if [[ -f "$HOME/$f" ]]; then
        detected="$HOME/$f"
        break
      fi
    done
  fi

  [[ -n "$detected" ]] && echo "$detected"
}

# Appends the sonarqube-cli PATH export to the best shell profile.
# Skips if the install directory is already on PATH or if the export is already present.
update_profile() {
  if [[ "${CUSTOM_INSTALL_DIR:-false}" == true ]]; then
    return
  fi

  if [[ ":${PATH}:" == *":${INSTALL_DIR}:"* ]]; then
    echo "Install directory is already in PATH, skipping profile update."
    return
  fi

  local path_line="export PATH=\"${INSTALL_DIR}:\$PATH\""
  local detected_profile
  detected_profile="$(detect_profile || true)"

  if [[ -z "$detected_profile" ]]; then
    echo "No shell profile files found. Add the following line to your shell profile manually:"
    echo "  $path_line"
  elif grep -qF "${INSTALL_DIR}" "$detected_profile" 2>/dev/null; then
    echo "Already present in $detected_profile, skipping."
  else
    printf '\n# Added by sonarqube-cli installer\n%s\n' "$path_line" >> "$detected_profile"
    echo "Updated PATH in: $detected_profile"
  fi
}

CUSTOM_INSTALL_DIR=false
DISTRIBUTION="standalone"
FORCE=false
PINNED_VERSION=""

parse_args() {
  while [[ $# -gt 0 ]]; do
    local opt="$1"
    case "$opt" in
      --install-dir)
        local val="${2:-}"
        if [[ -z "$val" ]]; then
          echo "Error: --install-dir requires a path." >&2
          exit 1
        fi
        INSTALL_DIR="$val"
        CUSTOM_INSTALL_DIR=true
        shift 2
        ;;
      --distribution)
        local val="${2:-}"
        if [[ -z "$val" ]]; then
          echo "Error: --distribution requires a value." >&2
          exit 1
        fi
        case "$val" in
          standalone|homebrew) ;;
          *)
            echo "Error: unknown distribution '$val'. Valid values: standalone, homebrew." >&2
            exit 1
            ;;
        esac
        DISTRIBUTION="$val"
        shift 2
        ;;
      --force)
        FORCE=true
        shift
        ;;
      --version)
        local val="${2:-}"
        if [[ -z "$val" ]]; then
          echo "Error: --version requires a value." >&2
          exit 1
        fi
        PINNED_VERSION="$val"
        shift 2
        ;;
      --artifact-base-url)
        local val="${2:-}"
        if [[ -z "$val" ]]; then
          echo "Error: --artifact-base-url requires a URL." >&2
          exit 1
        fi
        BASE_URL="$val"
        shift 2
        ;;
      *)
        echo "Unknown option: $opt" >&2
        exit 1
        ;;
    esac
  done
}

main() {
  parse_args "$@"

  if [[ "$CUSTOM_INSTALL_DIR" == false ]]; then
    INSTALL_DIR="$HOME/.local/share/sonarqube-cli/bin"
  fi

  local platform
  platform="$(detect_platform)"

  local version
  if [[ -n "$PINNED_VERSION" ]]; then
    version="$PINNED_VERSION"
    echo "Target version: $version"
  else
    version="$(resolve_latest_version)"
    echo "Latest version: $version"
  fi

  local os
  os="$(detect_os)"

  local dest="$INSTALL_DIR/$BINARY_NAME"

  # Skip download if the binary at the target path is already at the latest version.
  # Skipped when --install-dir is provided: the caller controls the target location and
  # must get the correctly-flavored binary (e.g. MDM distribution), regardless of version.
  if [[ "$CUSTOM_INSTALL_DIR" == false && "$FORCE" == false && -f "$dest" ]]; then
    local target_semver installed_version
    target_semver="$(echo "$version" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')"
    installed_version="$("$dest" --version 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' || true)"
    if [[ -n "$installed_version" && "$installed_version" == "$target_semver" ]]; then
      echo "Already at version $version, nothing to do."
      update_profile
      exit 0
    fi
  fi

  local artifact_basename="sonarqube-cli-${version}-${platform}"
  TMP_DIR="$(mktemp -d -t 'sonarqube-cli-install.XXXXXX')"

  echo "Detected platform: $platform"
  echo "Downloading sonarqube-cli from:"

  mkdir -p "$INSTALL_DIR"

  if [[ ! -w "$INSTALL_DIR" ]]; then
    echo "Error: no write permission on $INSTALL_DIR. Re-run with sudo or trigger via JumpCloud (SYSTEM)." >&2
    exit 1
  fi

  local tmp_bin="$TMP_DIR/$artifact_basename"

  download_cli_artifact "$version" "$platform" "$os" "$tmp_bin"

  mv "$tmp_bin" "$dest"
  chmod +x "$dest"

  if [[ "$platform" == macos-* ]]; then
    xattr -d com.apple.quarantine "$dest" 2>/dev/null || true
  fi

  echo "Installed sonar to: $dest"

  local path_was_present=false
  if [[ ":${PATH}:" == *":${INSTALL_DIR}:"* ]]; then
    path_was_present=true
  fi

  update_profile

  echo ""
  echo "Installation complete!"
  echo ""
  echo "sonar has been installed to: $dest"

  if [[ "$path_was_present" == false ]]; then
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
  fi

  echo "Once ready, run 'sonar --help' to get started."
}

main "$@"
