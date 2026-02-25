#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'sonarqube-cli\bin'
$BinaryName = 'sonar.exe'
$BaseUrl    = 'https://binaries.sonarsource.com/Distribution/sonarqube-cli'
$Platform   = 'windows-x86-64'

function Resolve-LatestVersion {
    $Version = (Invoke-WebRequest -Uri "$BaseUrl/latest-version.txt" -UseBasicParsing).Content.Trim()
    if (-not $Version) {
        Write-Error 'Could not determine the latest version.'
        exit 1
    }
    $Version
}

function Get-RemoteFile {
    param(
        [string]$Url,
        [string]$Dest
    )
    Write-Host "  $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
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

#Write-Host 'Fetching latest version...'
#$SonarVersion = Resolve-LatestVersion

$SonarVersion = "0.3.0.243"
Write-Host "Latest version: $SonarVersion"

$Filename     = "sonarqube-cli-$SonarVersion-$Platform.exe"
$Url          = "$BaseUrl/$Filename"
$Dest         = Join-Path $InstallDir $BinaryName

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $TmpDir | Out-Null

try {
    $TmpBin = Join-Path $TmpDir $Filename

    Write-Host "Downloading sonarqube-cli from:"
    Get-RemoteFile -Url $Url -Dest $TmpBin

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir | Out-Null
    }

    Move-Item -Path $TmpBin -Destination $Dest -Force
    Write-Host "Installed sonar to: $Dest"

    Add-ToUserPath -Dir $InstallDir

    Write-Host ''
    Write-Host 'Installation complete.'
    Write-Host 'To use sonar in your current session, run:'
    Write-Host "  `$env:PATH = `"$InstallDir;`$env:PATH`""
}
finally {
    Remove-Item -Recurse -Force -Path $TmpDir -ErrorAction SilentlyContinue
}
