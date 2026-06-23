#!/usr/bin/env bash
# JumpCloud Command: IS > Prod > Mac + Linux > Remove SonarQube CLI
# Removes the MDM-managed binary from /usr/local/bin.
# Does NOT affect standalone (~/.local/share/sonarqube-cli/bin) or Homebrew installs.
set -euo pipefail

MDM_BINARY="/usr/local/bin/sonar"

if [[ ! -f "$MDM_BINARY" ]]; then
    echo "MDM binary not found at $MDM_BINARY — nothing to remove."
    exit 0
fi

version="$("$MDM_BINARY" --version 2>/dev/null || echo unknown)"
rm -f "$MDM_BINARY"
echo "Removed SonarQube CLI v$version from $MDM_BINARY."
