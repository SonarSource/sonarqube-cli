# Cross-platform installation script for Windows (PowerShell)
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$BinaryName = "sonar-cli.exe"
$InstallName = "sonar.exe"
$InstallDir = "$env:LOCALAPPDATA\Programs\sonar-cli"

Write-Host "🚀 Installing Sonar CLI..." -ForegroundColor Cyan
Write-Host ""

# Change to project root
Set-Location $ProjectRoot

# Step 1: Install dependencies
Write-Host "📦 Installing dependencies..." -ForegroundColor Yellow
if (Get-Command npm -ErrorAction SilentlyContinue) {
    npm install
} else {
    Write-Host "❌ npm not found. Please install Node.js." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "✅ Dependencies installed" -ForegroundColor Green
Write-Host ""

# Step 2: Build binary
Write-Host "🔨 Building binary..." -ForegroundColor Yellow
npm run build:binary

Write-Host ""
Write-Host "✅ Binary built" -ForegroundColor Green
Write-Host ""

# Step 3: Install binary to PATH
$BinaryPath = Join-Path $ProjectRoot "dist\$BinaryName"

if (-not (Test-Path $BinaryPath)) {
    Write-Host "❌ Binary not found at $BinaryPath" -ForegroundColor Red
    exit 1
}

# Create install directory if it doesn't exist
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Copy binary
Write-Host "📦 Installing $InstallName to $InstallDir..." -ForegroundColor Yellow
Copy-Item -Path $BinaryPath -Destination (Join-Path $InstallDir $InstallName) -Force

# Add to PATH if not already there
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    Write-Host "📝 Adding to PATH..." -ForegroundColor Yellow
    [Environment]::SetEnvironmentVariable(
        "Path",
        "$UserPath;$InstallDir",
        "User"
    )
    $env:Path = "$env:Path;$InstallDir"
    Write-Host "✅ Added to PATH (restart terminal for changes to take effect)" -ForegroundColor Green
} else {
    Write-Host "✅ Already in PATH" -ForegroundColor Green
}

Write-Host ""
Write-Host "🎉 Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Testing installation:"
& (Join-Path $InstallDir $InstallName) --version

Write-Host ""
Write-Host "Usage: sonar --help"
Write-Host ""
Write-Host "To uninstall, run:"
Write-Host "  Remove-Item -Recurse -Force '$InstallDir'"
Write-Host "  And manually remove '$InstallDir' from your PATH environment variable"
