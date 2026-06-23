#Requires -Version 5.1
# JumpCloud Command: IS > Prod > Windows > Remove SonarQube CLI
# Removes the MDM-managed binary from C:\Program Files\sonarqube-cli\bin.
# Does NOT affect standalone (%LOCALAPPDATA%\sonarqube-cli\bin) installs.
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$MdmBinary = 'C:\Program Files\sonarqube-cli\bin\sonar.exe'

if (-not (Test-Path $MdmBinary)) {
    Write-Host "MDM binary not found at $MdmBinary -- nothing to remove."
    exit 0
}

$version = try { (& $MdmBinary --version).Trim() } catch { 'unknown' }
Remove-Item $MdmBinary -Force
Write-Host "Removed SonarQube CLI v$version from $MdmBinary."
