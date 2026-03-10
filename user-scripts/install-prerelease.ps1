#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$Version,

    [Parameter(Mandatory = $false)]
    [string]$Token = $env:ARTIFACTORY_ACCESS_TOKEN
)

$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'sonarqube-cli\bin'
$BinaryName = 'sonar.exe'
$BaseUrl    = 'https://repox.jfrog.io/artifactory/sonarsource-public-builds/org/sonarsource/cli/sonarqube-cli'
$Platform   = 'windows-x86-64'

if (-not $Token) {
    Write-Error 'JFrog token is required. Pass -Token or set the ARTIFACTORY_ACCESS_TOKEN environment variable.'
    exit 1
}

function Resolve-LatestVersion {
    param([string]$Token)
    $ApiUrl  = 'https://repox.jfrog.io/artifactory/api/search/latestVersion?g=org.sonarsource.cli&a=sonarqube-cli&repos=sonarsource-public-builds'
    $Headers = @{ Authorization = "Bearer $Token" }
    $Version = (Invoke-WebRequest -Uri $ApiUrl -Headers $Headers -UseBasicParsing).Content.Trim()
    if (-not $Version) {
        Write-Error 'Could not determine the latest pre-release version.'
        exit 1
    }
    $Version
}

function Get-RemoteFileWithAuth {
    param(
        [string]$Url,
        [string]$Dest,
        [string]$Token
    )
    Write-Host "  $Url"
    $Headers = @{ Authorization = "Bearer $Token" }
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $Url -OutFile $Dest -Headers $Headers -UseBasicParsing
}

function Add-ToUserPath {
    param([string]$Dir)
    $CurrentPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    if ($CurrentPath -split ';' -contains $Dir) {
        Write-Host 'PATH already contains the install directory, skipping.'
        return
    }
    $NewPath = $Dir + ';' + $CurrentPath
    [Environment]::SetEnvironmentVariable('PATH', $NewPath, 'User')
    Write-Host "Added to user PATH: $Dir"
}

# --- Main ---

if (-not $Version) {
    Write-Host 'Fetching latest pre-release version...'
    $Version = Resolve-LatestVersion -Token $Token
}

$Filename = "sonarqube-cli-$Version-$Platform.exe"
$Url      = "$BaseUrl/$Version/$Filename"
$Dest     = Join-Path $InstallDir $BinaryName

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $TmpDir | Out-Null

try {
    $TmpBin = Join-Path $TmpDir $Filename

    Write-Host "Installing pre-release sonarqube-cli $Version"
    Write-Host "Downloading from:"
    Get-RemoteFileWithAuth -Url $Url -Dest $TmpBin -Token $Token

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir | Out-Null
    }

    Copy-Item -Path $TmpBin -Destination $Dest -Force
    Write-Host "Installed sonar to: $Dest"

    Add-ToUserPath -Dir $InstallDir

    Write-Host ''
    Write-Host "Installation complete! (pre-release $Version)"
    Write-Host ''
    Write-Host "sonar has been installed to: $Dest"
    Write-Host ''
    Write-Host 'What happens next:'
    Write-Host '  - Any NEW terminal window you open will have sonar available automatically.'
    Write-Host '  - This current terminal window won''t see it yet - you have two options:'
    Write-Host ''
    Write-Host '    Option 1: Open a new terminal window (recommended)'
    Write-Host ''
    Write-Host '    Option 2: Activate it in this window right now by running:'
    Write-Host "      `$env:PATH = `"$InstallDir;`$env:PATH`""
    Write-Host '      (This only applies to this window - you won''t need to run it again.)'
    Write-Host ''
    Write-Host "Once ready, run 'sonar --help' to get started."
}
finally {
    Remove-Item -Recurse -Force -Path $TmpDir -ErrorAction SilentlyContinue
}
