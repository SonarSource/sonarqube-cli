#!/bin/bash
# Setup script for integration test resources.
# Downloads and places the sonar-secrets binary required by integration tests.
#
# Usage:
#   bash build-scripts/setup-integration-resources.sh
#
# Prerequisites:
#   - sonarqube-cli must be installed (run: npm install -g .)
#   - Run once before running integration tests on a new machine

set -euo pipefail

RESOURCES_DIR="tests/integration/resources"
BINARY_PATH="$RESOURCES_DIR/sonar-secrets"

if [ -f "$BINARY_PATH" ] && [ -x "$BINARY_PATH" ] && file "$BINARY_PATH" | grep -q "executable"; then
  echo "sonar-secrets binary already present at $BINARY_PATH"
  "$BINARY_PATH" --version
  exit 0
fi

echo "Installing sonar-secrets binary for integration tests..."
sonar install secrets

# Determine platform binary name
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
if [[ "$ARCH" == "x86_64" ]]; then ARCH="x64"; fi
if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then ARCH="arm64"; fi

INSTALLED_BINARY="$HOME/.sonar/sonarqube-cli/bin/sonar-secrets"

if [ ! -f "$INSTALLED_BINARY" ]; then
  echo "Error: sonar-secrets was not found at $INSTALLED_BINARY after install" >&2
  exit 1
fi

cp "$INSTALLED_BINARY" "$BINARY_PATH"
chmod +x "$BINARY_PATH"

echo "sonar-secrets binary copied to $BINARY_PATH"
"$BINARY_PATH" --version
