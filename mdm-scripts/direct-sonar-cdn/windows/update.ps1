#Requires -Version 5.1
# Ensures the MDM binary is present, then updates it to the latest version.
# SONARQUBE_CLI_FORCE             -- optional JumpCloud variable; set to "true" to replace even when already at latest.
# SONARQUBE_CLI_APPROVED_VERSION  -- optional JumpCloud variable; pins the update version instead of
#                      using stable.version.
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$MdmBinary       = 'C:\Program Files\sonarqube-cli\bin\sonar.exe'
$ArtifactBaseUrl = 'https://binaries.sonarsource.com/Distribution/sonarqube-cli'
# JumpCloud-specific: {{SONARQUBE_CLI_FORCE}} / {{SONARQUBE_CLI_APPROVED_VERSION}} are replaced with
# the Custom Variable's value at runtime -- not real $env: variables. Other MDM systems may inject
# this differently.
# Note: JumpCloud quotes String-typed variables (e.g. SONARQUBE_CLI_APPROVED_VERSION) but
# substitutes a Boolean-typed variable (SONARQUBE_CLI_FORCE) as an unquoted bareword (true/false), so we quote
# it ourselves below to keep it a valid string literal.
$ApprovedVersionOverride = {{SONARQUBE_CLI_APPROVED_VERSION}}
if ($ApprovedVersionOverride -isnot [string]) { $ApprovedVersionOverride = $null }
# Defense-in-depth: a valid version can't contain quotes/$()/backticks, so this closes off
# variable-substitution injection regardless of how the MDM tool quotes Custom Variables.
if ($ApprovedVersionOverride -and $ApprovedVersionOverride -notmatch '^[0-9][0-9.]*$') {
    Write-Error "SONARQUBE_CLI_APPROVED_VERSION has an invalid format: $ApprovedVersionOverride"
    exit 1
}
$Platform        = 'windows-x86-64'
$ForceUpdate     = '{{SONARQUBE_CLI_FORCE}}' -eq 'true'
$env:PATH        = "$(Split-Path $MdmBinary);$env:PATH"

# -- Helpers -------------------------------------------------------------------

function Get-TargetVersion {
    if ($ApprovedVersionOverride) { return $ApprovedVersionOverride }
    (Invoke-WebRequest -Uri "$ArtifactBaseUrl/stable.version" -UseBasicParsing).Content.Trim()
}

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

$targetVersion = Get-TargetVersion
Write-Host "Target version: $targetVersion"

$targetSemver = ($targetVersion -split '\.')[0..2] -join '.'

if (Test-Path $MdmBinary) {
    $installedRaw = (& $MdmBinary --version 2>$null | Out-String)
    $installedSemver = ([regex]'\d+\.\d+\.\d+').Match($installedRaw).Value
    if (-not $ForceUpdate -and $installedSemver -eq $targetSemver) {
        Write-Host "Already at version $targetVersion, nothing to do."
        exit 0
    }
    Write-Host "Updating $installedSemver -> $targetSemver..."
} else {
    Write-Host 'MDM binary not found -- installing first...'
}

Install-SonarBinary -Version $targetVersion -Dest $MdmBinary

Write-Host "MDM sonar: $MdmBinary -- $(& $MdmBinary --version)"
$sonarWhere = try { (Get-Command sonar -ErrorAction Stop).Source } catch { 'not found' }
Write-Host "where sonar: $sonarWhere"
if ($sonarWhere -ne 'not found') { Write-Host "sonar -v:    $(sonar --version)" }
