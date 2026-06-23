#Requires -Version 5.1
# JumpCloud Command: IS > Prod > Windows > Remove SonarQube CLI (enforcing)
# Removes the MDM-managed binary, then keeps removing wherever sonar resolves
# until 'where sonar' returns nothing.
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$MdmBinary = 'C:\Program Files\sonarqube-cli\bin\sonar.exe'
$env:PATH  = "$(Split-Path $MdmBinary);$env:PATH"

# Remove MDM binary
Remove-Item $MdmBinary -Force -ErrorAction SilentlyContinue

if (Test-Path $MdmBinary) {
    Write-Error "Failed to remove $MdmBinary"
    exit 1
}
Write-Host "MDM binary removed from $MdmBinary."

# Enforcing: keep removing wherever sonar resolves until it is completely gone.
while ($true) {
    $sonarPath = try { (Get-Command sonar -ErrorAction Stop).Source } catch { $null }
    if (-not $sonarPath) { break }
    Write-Host "sonar still resolves to: $sonarPath -- removing..."
    Remove-Item $sonarPath -Force -ErrorAction SilentlyContinue
    if (Test-Path $sonarPath) {
        Write-Error "Failed to remove $sonarPath"
        exit 1
    }
}

Write-Host "where sonar: not found"
