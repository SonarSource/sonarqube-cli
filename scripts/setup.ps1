# --- 1. Dependencies ---
Write-Host "Checking Node, NPM, and Bun..." -ForegroundColor Cyan
if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw "Node missing" }
if (!(Get-Command npm -ErrorAction SilentlyContinue)) { throw "NPM missing" }
if (!(Get-Command bun -ErrorAction SilentlyContinue)) { throw "Bun missing" }
Write-Host "[x] All dependencies found." -ForegroundColor Green

# --- 2. Paths ---
$installDir = "$env:LOCALAPPDATA\Programs\sonar-cli"
$sourcePath = "$PSScriptRoot\..\dist\sonar-cli.exe"
$destPath = "$installDir\sonar-cli.exe"

# --- 3. Build ---
Write-Host "`nBuilding project..." -ForegroundColor Cyan
bun install
bun run build:binary

# --- 4. Install ---
if (!(Test-Path $installDir)) { 
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null 
}
Copy-Item -Path $sourcePath -Destination $destPath -Force
Write-Host "[x] Binary installed to $installDir" -ForegroundColor Green

# --- 5. Path Update (or Skip if already exists) ---
$regPath = "HKCU:\Environment"
$oldPath = (Get-ItemProperty -Path $regPath -Name Path).Path

# Split the path by semicolons and check for an exact match
if ($oldPath -split ';' -contains $installDir) {
    Write-Host "`n[i] Note: $installDir is already in your PATH. Skipping update." -ForegroundColor Gray
} else {
    $newPath = "$oldPath;$installDir"
    $newPath = $newPath.Replace(";;", ";")
    Set-ItemProperty -Path $regPath -Name Path -Value $newPath
    Write-Host "`nSUCCESS: Added to PATH. Restart terminal to use 'sonar-cli'." -ForegroundColor Green
}