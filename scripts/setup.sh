#!/usr/bin/env bash

# Cross-platform installation script for macOS and Linux
# Installs to user directory (no sudo required) and auto-configures shell
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BINARY_NAME="sonarqube-cli"
INSTALL_NAME="sonar"

# Install to user directory (no sudo needed)
INSTALL_DIR="$HOME/.sonarqube-cli/bin"

echo "🚀 Installing Sonar CLI..."
echo ""

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Darwin*|Linux*)
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

# Ensure bun is available for build:binary (which uses bun build ...)
if ! command -v bun &> /dev/null; then
    echo "❌ bun not found. The build:binary script requires Bun (https://bun.sh)."
    echo "   Please install Bun and ensure 'bun' is available on your PATH, then re-run this script."
    exit 1
fi

# Step 2: Build binary
echo "🔨 Building binary..."
npm run build:binary

echo ""
echo "✅ Binary built"
echo ""

# Step 3: Install binary to user directory (no sudo needed)
BINARY_PATH="dist/$BINARY_NAME"

if [ ! -f "$BINARY_PATH" ]; then
    echo "❌ Binary not found at $BINARY_PATH"
    exit 1
fi

# Create install directory
mkdir -p "$INSTALL_DIR"

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
    rm -f "$INSTALL_DIR/$INSTALL_NAME"
fi

# Install binary (no sudo needed)
echo "📦 Installing $INSTALL_NAME to $INSTALL_DIR..."
cp "$BINARY_PATH" "$INSTALL_DIR/$INSTALL_NAME"
echo "✅ Installed successfully!"

# Step 4: Auto-configure shell PATH (like Bun does)
echo ""
echo "🔧 Configuring shell..."

# Detect shell and config file
SHELL_NAME="$(basename "$SHELL")"
SHELL_CONFIG=""
PATH_EXPORT="export PATH=\"\$HOME/.sonarqube-cli/bin:\$PATH\""

case "$SHELL_NAME" in
    zsh)
        SHELL_CONFIG="$HOME/.zshrc"
        ;;
    bash)
        # Check for .bash_profile first (macOS), then .bashrc (Linux)
        if [ -f "$HOME/.bash_profile" ]; then
            SHELL_CONFIG="$HOME/.bash_profile"
        else
            SHELL_CONFIG="$HOME/.bashrc"
        fi
        ;;
    fish)
        SHELL_CONFIG="$HOME/.config/fish/config.fish"
        PATH_EXPORT="fish_add_path \$HOME/.sonarqube-cli/bin"
        ;;
    *)
        echo "⚠️  Shell '$SHELL_NAME' not automatically supported."
        SHELL_CONFIG=""
        ;;
esac

# Check if PATH already configured
PATH_CONFIGURED=false
if [ -n "$SHELL_CONFIG" ] && [ -f "$SHELL_CONFIG" ]; then
    if grep -q ".sonarqube-cli/bin" "$SHELL_CONFIG" 2>/dev/null; then
        PATH_CONFIGURED=true
        echo "✅ Shell already configured ($SHELL_CONFIG)"
    fi
fi

# Add to PATH if not already configured
if [ "$PATH_CONFIGURED" = false ] && [ -n "$SHELL_CONFIG" ]; then
    echo "" >> "$SHELL_CONFIG"
    echo "# Sonar CLI" >> "$SHELL_CONFIG"
    echo "$PATH_EXPORT" >> "$SHELL_CONFIG"
    echo "✅ Added to PATH in $SHELL_CONFIG"
    echo ""
    echo "📝 To use immediately, run:"
    echo "   source $SHELL_CONFIG"
    echo "   OR restart your terminal"
elif [ -z "$SHELL_CONFIG" ]; then
    echo ""
    echo "📝 Manual PATH setup required:"
    echo "   Add this line to your shell config:"
    echo "   $PATH_EXPORT"
fi

echo ""
echo "🎉 Installation complete!"
echo ""

# Test if sonar is in PATH (in current session)
if command -v "$INSTALL_NAME" &> /dev/null; then
    echo "Testing installation:"
    "$INSTALL_NAME" --version
    echo ""
    echo "✅ Ready to use: $INSTALL_NAME --help"
else
    echo "⚠️  Note: Restart your terminal or run 'source $SHELL_CONFIG' to use '$INSTALL_NAME'"
fi

echo ""
echo "To uninstall, run:"
echo "  rm -rf ~/.sonarqube-cli"
echo "  (and remove the PATH line from $SHELL_CONFIG)"
