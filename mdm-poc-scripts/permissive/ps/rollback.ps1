#Requires -Version 5.1
# JumpCloud Command: IS > Prod > Windows > Rollback SonarQube CLI
# Set ROLLBACK_VERSION via JumpCloud env var injection, e.g. ROLLBACK_VERSION="1.1.0.3122".
# ARTIFACT_BASE_URL -- optional JumpCloud env var; overrides the binary download source.
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$MdmBinary       = 'C:\Program Files\sonarqube-cli\bin\sonar.exe'
$ArtifactBaseUrl = if ($env:ARTIFACT_BASE_URL) { $env:ARTIFACT_BASE_URL } else { 'https://binaries.sonarsource.com/Distribution/sonarqube-cli' }
$Platform        = 'windows-x86-64'
$RollbackVersion   = $env:ROLLBACK_VERSION
if (-not $RollbackVersion) {
    Write-Error 'ROLLBACK_VERSION must be set via JumpCloud env var injection.'
    exit 1
}

# -- Helpers -------------------------------------------------------------------

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

Write-Host "Rolling back to version $RollbackVersion..."

Install-SonarBinary -Version $RollbackVersion -Dest $MdmBinary
Test-BinarySha256   -Binary $MdmBinary -Version $RollbackVersion

Write-Host "MDM sonar: $MdmBinary -- $(& $MdmBinary --version)"
