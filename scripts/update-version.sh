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
echo "Files using VERSION constant:"
echo "  • src/daemon/backend/rpc.ts"
echo "  • src/sonarqube/client.ts"
echo ""
echo "Next steps:"
echo "  npm run build    # Rebuild TypeScript"
echo "  sonar --version  # Verify new version"
