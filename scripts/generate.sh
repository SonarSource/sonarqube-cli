#!/bin/bash

# Automated code generation from cli-spec.yaml
# Generates: commands, index.ts registration, documentation

set -e

echo "🔄 Generating commands from cli-spec.yaml..."
echo "y" | npx plop all-commands > /dev/null 2>&1

echo "🔄 Synchronizing src/index.ts..."
echo "y" | npx plop sync-index > /dev/null 2>&1

echo "🔄 Generating documentation..."
npx plop docs > /dev/null 2>&1

echo "✅ Generation complete!"
echo ""
echo "Next steps:"
echo "  npm run validate    # Validate generated code"
echo "  npm run build       # Build TypeScript"
