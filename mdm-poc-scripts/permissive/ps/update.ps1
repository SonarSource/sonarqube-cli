#Requires -Version 5.1
# JumpCloud Command: IS > Prod > Windows > Update SonarQube CLI
# Downloads and installs the latest CLI version, replacing the existing MDM binary.
# FORCE     -- optional JumpCloud env var; if set, replaces even when already at latest.
# ARTIFACT_BASE_URL -- optional JumpCloud env var; overrides the binary download source.
# Note: on Windows self-update spawns a detached terminal, so we download directly
# to keep the entire operation synchronous and verifiable within this script.
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$MdmBinary       = 'C:\Program Files\sonarqube-cli\bin\sonar.exe'
$ArtifactBaseUrl = if ($env:ARTIFACT_BASE_URL) { $env:ARTIFACT_BASE_URL } else { 'https://binaries.sonarsource.com/Distribution/sonarqube-cli' }
$Platform        = 'windows-x86-64'
$ForceUpdate     = [bool]$env:FORCE

# -- Helpers -------------------------------------------------------------------

function Get-LatestVersion {
    (Invoke-WebRequest -Uri "$ArtifactBaseUrl/stable.version" -UseBasicParsing).Content.Trim()
}

function Test-BinarySha256 {
    param([string]$Binary, [string]$Version)
    $base = "sonarqube-cli-$Version-$Platform"
    $url  = "$ArtifactBaseUrl/$Version/windows/$base.exe.sha256"
    try {
        $raw      = (Invoke-WebRequest -Uri $url -UseBasicParsing -ErrorAction Stop).Content.Trim()
        $expected = ($raw -split '\s+')[0].ToLower()
    } catch {
        Write-Warning "Could not fetch SHA256 from $url -- skipping integrity check."
        return
    }
    $actual = (Get-FileHash -Path $Binary -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
        Write-Error "SHA256 mismatch for $Binary`n  expected: $expected`n  actual:   $actual"
        exit 1
    }
    Write-Host "SHA256 verified: $Binary ($Version)"
}

function Install-SonarBinary {
    param([string]$Version, [string]$Dest)
    $base = "sonarqube-cli-$Version-$Platform"
    $url  = "$ArtifactBaseUrl/$Version/windows/$base.exe"
    $tmp  = [System.IO.Path]::GetTempFileName()
    Write-Host 'Downloading sonarqube-cli from:'
    Write-Host "  $url"
    try {
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
        $dir = Split-Path $Dest
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Move-Item $tmp $Dest -Force
        # Grant read+execute to all users -- binary is installed by SYSTEM so
        # default ACL may not include regular user access.
        & icacls $Dest /grant 'Authenticated Users:(RX)' | Out-Null
    } catch {
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        throw
    }
}

# -- Main ----------------------------------------------------------------------

$latestVersion = Get-LatestVersion
Write-Host "Latest version: $latestVersion"

$latestSemver = ($latestVersion -split '\.')[0..2] -join '.'

if (Test-Path $MdmBinary) {
    $installedSemver = (& $MdmBinary --version).Trim()
    if (-not $ForceUpdate -and $installedSemver -eq $latestSemver) {
        Write-Host "Already at version $latestVersion, nothing to do."
        exit 0
    }
    Write-Host "Updating $installedSemver -> $latestSemver..."
} else {
    Write-Host "MDM binary not found -- installing..."
    $dir = Split-Path $MdmBinary
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

Install-SonarBinary -Version $latestVersion -Dest $MdmBinary
Test-BinarySha256   -Binary $MdmBinary -Version $latestVersion

Write-Host "MDM sonar: $MdmBinary -- $(& $MdmBinary --version)"
