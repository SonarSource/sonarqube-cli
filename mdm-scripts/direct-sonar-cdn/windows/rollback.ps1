#Requires -Version 5.1
# Ensures the MDM binary is present, then rolls back to SONARQUBE_CLI_ROLLBACK_VERSION.
# SONARQUBE_CLI_ROLLBACK_VERSION    -- required JumpCloud variable (e.g. 1.1.0.3122).
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$MdmBinary       = 'C:\Program Files\sonarqube-cli\bin\sonar.exe'
$ArtifactBaseUrl = 'https://binaries.sonarsource.com/Distribution/sonarqube-cli'
$Platform        = 'windows-x86-64'
# JumpCloud-specific: {{SONARQUBE_CLI_ROLLBACK_VERSION}} is replaced with the Custom Variable's
# value (quoted) at runtime -- not a real $env: variable. Other MDM systems may inject this
# differently.
$RollbackVersion = {{SONARQUBE_CLI_ROLLBACK_VERSION}}
if ($RollbackVersion -isnot [string]) { $RollbackVersion = $null }
$env:PATH        = "$(Split-Path $MdmBinary);$env:PATH"

if (-not $RollbackVersion) {
    Write-Error 'SONARQUBE_CLI_ROLLBACK_VERSION must be set via JumpCloud variable injection.'
    exit 1
}
# Defense-in-depth: a valid version can't contain quotes/$()/backticks, so this closes off
# variable-substitution injection regardless of how the MDM tool quotes Custom Variables.
if ($RollbackVersion -notmatch '^[0-9][0-9.]*$') {
    Write-Error "SONARQUBE_CLI_ROLLBACK_VERSION has an invalid format: $RollbackVersion"
    exit 1
}

# -- Helpers -------------------------------------------------------------------

function Test-BinarySha256 {
    param([string]$Binary, [string]$Version)
    $base = "sonarqube-cli-$Version-$Platform"
    $url  = "$ArtifactBaseUrl/$Version/windows/$base.exe.sha256"
    try {
        $raw = (Invoke-WebRequest -Uri $url -UseBasicParsing -ErrorAction Stop).Content
        # Server sends this file as binary/octet-stream, so Windows PowerShell 5.1
        # returns Content as byte[] instead of a string -- decode it explicitly.
        if ($raw -is [byte[]]) { $raw = [System.Text.Encoding]::UTF8.GetString($raw) }
        $expected = ($raw.Trim() -split '\s+')[0].ToLower()
    } catch {
        Write-Error "Could not fetch SHA256 from $url -- aborting.`n  $($_.Exception.Message)"
        exit 1
    }
    $actual = (Get-FileHash -Path $Binary -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) {
        Write-Error "SHA256 mismatch for $Binary`n  expected: $expected`n  actual:   $actual"
        exit 1
    }
    Write-Output "SHA256 verified: $Binary ($Version)"
}

function Install-SonarBinary {
    param([string]$Version, [string]$Dest)
    $base = "sonarqube-cli-$Version-$Platform"
    $url  = "$ArtifactBaseUrl/$Version/windows/$base.exe"
    $tmp  = [System.IO.Path]::GetTempFileName()
    Write-Output 'Downloading sonarqube-cli from:'
    Write-Output "  $url"
    try {
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
        Test-BinarySha256 -Binary $tmp -Version $Version
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

Write-Host "MDM sonar: $MdmBinary -- $(& $MdmBinary --version)"
$sonarWhere = try { (Get-Command sonar -ErrorAction Stop).Source } catch { 'not found' }
Write-Host "where sonar: $sonarWhere"
if ($sonarWhere -ne 'not found') { Write-Host "sonar -v:    $(sonar --version)" }
