#!/bin/bash

# Update version across the project
# Usage: ./scripts/update-version.sh <new-version>
#
# Example: ./scripts/update-version.sh 0.3.0

set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <new-version>"
  echo "Example: $0 0.3.0"
  exit 1
fi

NEW_VERSION=$1

echo "🔄 Updating version to $NEW_VERSION..."

# Update package.json
echo "  📝 Updating package.json..."
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" package.json

# Update cli-spec.yaml
echo "  📝 Updating cli-spec.yaml..."
sed -i '' "s/\(  version: \)[0-9.][0-9.]*/\1$NEW_VERSION/" cli-spec.yaml

# Update src/version.ts
echo "  📝 Updating src/version.ts..."
sed -i '' "s/export const VERSION = '[^']*'/export const VERSION = '$NEW_VERSION'/" src/version.ts

# Regenerate src/index.ts to pick up new version from cli-spec.yaml
echo "  🔄 Regenerating src/index.ts..."
echo "y" | npx plop sync-index > /dev/null 2>&1

echo ""
echo "✅ Version updated to $NEW_VERSION"
echo ""
echo "Files updated:"
echo "  • package.json"
echo "  • cli-spec.yaml"
echo "  • src/version.ts"
echo "  • src/index.ts (regenerated)"
echo ""

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build

# Build binary
echo "📦 Building binary..."
npm run build:binary

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

  brew reinstall local/sonar/sonar > /dev/null 2>&1 || true
  brew link --overwrite sonar > /dev/null 2>&1 || true

  echo "  • Formula: $NEW_VERSION (sha256: ${NEW_SHA256:0:16}...)"
fi

echo ""
echo "🎉 Done! Verifying..."
sonar --version
