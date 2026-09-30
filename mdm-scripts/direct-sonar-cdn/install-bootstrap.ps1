#Requires -Version 5.1
# Installs the CLI system-wide and replaces per-user standalone installs with symlinks to it.
# SONARQUBE_CLI_APPROVED_VERSION -- optional JumpCloud variable; pins the install version instead of using stable.version.
# SONARQUBE_CLI_ARTIFACT_BASE_URL -- optional JumpCloud variable; overrides the download source.
# Runs `sonar mdm <action>`; when the installed CLI predates `sonar mdm` (or is missing), a verified
# copy of the stable release is downloaded and used to run the action instead.
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# JumpCloud-specific: {{VAR}} placeholders below are replaced with the Custom Variable's value (quoted)
# at runtime -- not real $env: variables. Other MDM systems may inject this differently.
$ApprovedVersion = {{SONARQUBE_CLI_APPROVED_VERSION}}
if ($ApprovedVersion -isnot [string]) { $ApprovedVersion = $null }
$ArtifactBaseUrlOverride = {{SONARQUBE_CLI_ARTIFACT_BASE_URL}}
if ($ArtifactBaseUrlOverride -isnot [string]) { $ArtifactBaseUrlOverride = $null }
if ($ApprovedVersion -and $ApprovedVersion -notmatch '^[0-9][0-9.]*$') { Write-Error "SONARQUBE_CLI_APPROVED_VERSION has an invalid format: $ApprovedVersion"; exit 1 }

$MdmBinary = 'C:\Program Files\sonarqube-cli\bin\sonar.exe'
$DefaultArtifactBaseUrl = 'https://binaries.sonarsource.com/Distribution/sonarqube-cli'
$AllowMissingChecksum = $false

function Get-Text {
    param([string]$Url)
    $raw = (Invoke-WebRequest -Uri $Url -UseBasicParsing -ErrorAction Stop).Content
    if ($raw -is [byte[]]) { $raw = [System.Text.Encoding]::UTF8.GetString($raw) }
    $raw.Trim()
}

function Get-StableVersion {
    $stable = Get-Text "$ArtifactBaseUrl/stable.version"
    if ($stable -notmatch '^[0-9][0-9.]*$') { Write-Error "Could not determine a valid stable version: $stable"; exit 1 }
    $stable
}

function Get-Runner {
    param([string]$Version)
    $url = "$ArtifactBaseUrl/$Version/windows/sonarqube-cli-$Version-windows-x86-64.exe"
    $runner = Join-Path ([System.IO.Path]::GetTempPath()) "sonar-mdm-$([guid]::NewGuid()).exe"
    Invoke-WebRequest -Uri $url -OutFile $runner -UseBasicParsing
    try {
        $expected = ((Get-Text "$url.sha256") -split '\s+')[0].ToLower()
    } catch {
        if (-not $AllowMissingChecksum) { Remove-Item $runner -Force -ErrorAction SilentlyContinue; Write-Error "Could not fetch SHA256 from $url.sha256 -- aborting."; exit 1 }
        Write-Warning "Could not fetch SHA256 from $url.sha256 -- skipping integrity check."
        return $runner
    }
    $actual = (Get-FileHash -Path $runner -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected) { Remove-Item $runner -Force -ErrorAction SilentlyContinue; Write-Error "SHA256 mismatch`n  expected: $expected`n  actual:   $actual"; exit 1 }
    Write-Host "SHA256 verified ($Version)"
    $runner
}

function Test-MdmSupport {
    if (-not (Test-Path $MdmBinary)) { return $false }
    & $MdmBinary mdm --help *> $null
    $LASTEXITCODE -eq 0
}

$script:TempRunner = $null
function Select-Runner {
    if (Test-MdmSupport) { return $MdmBinary }
    Write-Host "Installed CLI is missing or does not support 'sonar mdm' -- using the stable release."
    $script:TempRunner = Get-Runner (Get-StableVersion)
    $script:TempRunner
}
$ArtifactBaseUrl = if ($ArtifactBaseUrlOverride) { $ArtifactBaseUrlOverride.TrimEnd('/') } else { $DefaultArtifactBaseUrl }
if ($ArtifactBaseUrl -notmatch '^https://[^\s"''`$]+$') { Write-Error "SONARQUBE_CLI_ARTIFACT_BASE_URL must be an https:// URL: $ArtifactBaseUrl"; exit 1 }

$version = if ($ApprovedVersion) { $ApprovedVersion } else { Get-StableVersion }
Write-Host "Target version: $version"
$runner = Get-Runner $version
$script:TempRunner = $runner
$mdmArgs = @('install', '--approved-version', $version, '--artifact-base-url', $ArtifactBaseUrl)

try {
    & $runner mdm @mdmArgs
    exit $LASTEXITCODE
} finally {
    if ($script:TempRunner) { Remove-Item $script:TempRunner -Force -ErrorAction SilentlyContinue }
}
