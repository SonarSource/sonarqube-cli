#!/bin/bash

# Increment build number and rebuild the project.
#
# Usage:
#   ./build-scripts/update-version.sh           # increment build:  0.1.132 → 0.1.133
#   ./build-scripts/update-version.sh 1.0       # change major.minor, keep build: 0.1.132 → 1.0.132

set -e

BUILD_TIMEOUT=60  # seconds per build step

# Use gtimeout (GNU coreutils) or timeout (Linux) if available
TIMEOUT_CMD="$(command -v gtimeout 2>/dev/null || command -v timeout 2>/dev/null || echo '')"

run_with_timeout() {
  if [ -n "$TIMEOUT_CMD" ]; then
    "$TIMEOUT_CMD" "$BUILD_TIMEOUT" "$@" || {
      echo "❌ Command timed out after ${BUILD_TIMEOUT}s: $*"
      exit 1
    }
  else
    "$@"
  fi
}

CURRENT=$(node -e "console.log(require('./package.json').version)")
MAJOR_MINOR=$(echo "$CURRENT" | sed 's/\.[0-9]*$//')
BUILD=$(echo "$CURRENT" | sed 's/.*\.//')

if [ -n "$1" ]; then
  # If the argument already contains at least two dots (e.g. 1.2.3), use it as-is
  DOT_COUNT=$(echo "$1" | tr -cd '.' | wc -c | tr -d ' ')
  if [ "$DOT_COUNT" -ge 2 ]; then
    NEW_VERSION="$1"
  else
    NEW_VERSION="$1.$BUILD"
  fi
else
  NEW_VERSION="$MAJOR_MINOR.$((BUILD + 1))"
fi

echo "🔄 Updating version to $NEW_VERSION..."

# Update package.json (single source of truth)
echo "  📝 Updating package.json..."
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" package.json

# Update VERSION in src/version.ts (preserve license header)
echo "  📝 Updating src/version.ts..."
sed -i '' "s/export const VERSION = '[^']*';/export const VERSION = '$NEW_VERSION';/" src/version.ts

echo ""
echo "✅ Version updated to $NEW_VERSION"
echo ""

# Build TypeScript
echo "🔨 Building TypeScript..."
run_with_timeout npm run build

# Build binary
echo "📦 Building binary..."
run_with_timeout npm run build:binary

# Update Homebrew tap
BREW_FORMULA="/opt/homebrew/Library/Taps/local/homebrew-sonar/Formula/sonar.rb"
if [ -f "$BREW_FORMULA" ]; then
  echo "Updating Homebrew tap..."

  # Pack binary with expected name
  cp dist/sonarqube-cli /tmp/sonar-cli
  cd /tmp && tar -czf ~/sonar-cli.tar.gz sonar-cli
  cd - > /dev/null

  NEW_SHA256=$(shasum -a 256 ~/sonar-cli.tar.gz | awk '{print $1}')

  sed -i '' "s/version \"[^\"]*\"/version \"$NEW_VERSION\"/" "$BREW_FORMULA"
  sed -i '' "s/sha256 \"[^\"]*\"/sha256 \"$NEW_SHA256\"/" "$BREW_FORMULA"

  run_with_timeout brew reinstall local/sonar/sonar > /dev/null 2>&1 || true
  brew link --overwrite sonar > /dev/null 2>&1 || true

  echo "  • Formula: $NEW_VERSION (sha256: ${NEW_SHA256:0:16}...)"
fi

echo ""
echo "🎉 Done! Verifying..."
sonar --version
