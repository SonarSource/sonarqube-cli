#!/bin/bash
# Build standalone binaries for all platforms

set -e

echo "🔨 Building standalone binaries with Bun..."

# Create dist directory
mkdir -p dist/binaries

# Current platform (macOS ARM64)
echo "Building for macOS ARM64..."
~/.bun/bin/bun build src/index.ts --compile --outfile dist/binaries/sonar-cli-macos-arm64

# Note: Bun can only compile for the current platform
# For cross-platform builds, need to run on each platform or use Docker

echo "✅ Binary built: dist/binaries/sonar-cli-macos-arm64"
echo ""
echo "📦 File size:"
ls -lh dist/binaries/sonar-cli-macos-arm64
echo ""
echo "🎯 To build for other platforms:"
echo "  - Linux x64: Run on Linux machine or Docker"
echo "  - Windows x64: Run on Windows machine or Docker"
echo ""
echo "💡 Current binary works on: macOS ARM64 (M1/M2/M3)"
