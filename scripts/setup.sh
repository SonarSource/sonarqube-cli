#!/bin/bash

# Cross-platform installation script for macOS and Linux
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARY_NAME="sonar-cli"
INSTALL_NAME="sonar"

echo "🚀 Installing Sonar CLI..."
echo ""

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Darwin*)
        INSTALL_DIR="/usr/local/bin"
        ;;
    Linux*)
        INSTALL_DIR="/usr/local/bin"
        ;;
    *)
        echo "❌ Unsupported OS: $OS"
        exit 1
        ;;
esac

# Change to project root
cd "$PROJECT_ROOT"

# Step 1: Install dependencies
echo "📦 Installing dependencies..."
if command -v npm &> /dev/null; then
    npm install
else
    echo "❌ npm not found. Please install Node.js."
    exit 1
fi

echo ""
echo "✅ Dependencies installed"
echo ""

# Step 2: Build binary
echo "🔨 Building binary..."
npm run build:binary

echo ""
echo "✅ Binary built"
echo ""

# Step 3: Install binary to PATH
BINARY_PATH="dist/$BINARY_NAME"

if [ ! -f "$BINARY_PATH" ]; then
    echo "❌ Binary not found at $BINARY_PATH"
    exit 1
fi

# Make binary executable
chmod +x "$BINARY_PATH"

# Check if already installed
if [ -f "$INSTALL_DIR/$INSTALL_NAME" ] || [ -L "$INSTALL_DIR/$INSTALL_NAME" ]; then
    echo "⚠️  $INSTALL_NAME is already installed at $INSTALL_DIR/$INSTALL_NAME"
    read -p "   Overwrite? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Installation cancelled"
        exit 0
    fi
    echo "   Removing old installation..."
    sudo rm -f "$INSTALL_DIR/$INSTALL_NAME"
fi

# Install binary
echo "📦 Installing $INSTALL_NAME to $INSTALL_DIR..."
if cp "$BINARY_PATH" "$INSTALL_DIR/$INSTALL_NAME" 2>/dev/null; then
    echo "✅ Installed successfully!"
else
    echo "   Need sudo permissions..."
    sudo cp "$BINARY_PATH" "$INSTALL_DIR/$INSTALL_NAME"
    echo "✅ Installed successfully with sudo!"
fi

echo ""
echo "🎉 Installation complete!"
echo ""
echo "Testing installation:"
"$INSTALL_DIR/$INSTALL_NAME" --version

echo ""
echo "Usage: $INSTALL_NAME --help"
echo ""
echo "To uninstall, run:"
echo "  sudo rm $INSTALL_DIR/$INSTALL_NAME"
