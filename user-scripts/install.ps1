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

$SonarVersion = "0.4.0.345"
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
    Write-Host 'Installation complete!'
    Write-Host ''
    Write-Host "sonar has been installed to: $Dest"
    Write-Host ''
    Write-Host 'What happens next:'
    Write-Host '  - Any NEW terminal window you open will have sonar available automatically.'
    Write-Host '  - This current terminal window won''t see it yet — you have two options:'
    Write-Host ''
    Write-Host '    Option 1: Open a new terminal window (recommended)'
    Write-Host ''
    Write-Host '    Option 2: Activate it in this window right now by running:'
    Write-Host "      `$env:PATH = `"$InstallDir;`$env:PATH`""
    Write-Host '      (This only applies to this window — you won''t need to run it again.)'
    Write-Host ''
    Write-Host "Once ready, run 'sonar --help' to get started."
}
finally {
    Remove-Item -Recurse -Force -Path $TmpDir -ErrorAction SilentlyContinue
}
