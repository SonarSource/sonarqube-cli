#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'sonarqube-cli\bin'
$BinaryName = 'sonar.exe'
$BaseUrl    = 'https://binaries.sonarsource.com/CommercialDistribution/sonar-secrets'
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

function Test-Sha256 {
    param(
        [string]$File,
        [string]$ChecksumFile
    )
    $Expected = (Get-Content $ChecksumFile -Raw).Trim().Split()[0].ToLower()
    $Actual   = (Get-FileHash -Algorithm SHA256 -Path $File).Hash.ToLower()

    if ($Actual -ne $Expected) {
        Write-Error "SHA256 checksum mismatch!`n  Expected: $Expected`n  Actual:   $Actual"
        exit 1
    }
    Write-Host 'SHA256 checksum verified.'
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

Write-Host 'Fetching latest version...'
$SonarVersion = Resolve-LatestVersion -Platform $Platform
Write-Host "Latest version: $SonarVersion"

$Filename     = "sonar-secrets-$SonarVersion-$Platform.exe"
$Url          = "$BaseUrl/$Filename"
$ChecksumUrl  = "$Url.sha256"
$Dest         = Join-Path $InstallDir $BinaryName

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $TmpDir | Out-Null

try {
    $TmpBin      = Join-Path $TmpDir $Filename
    $TmpChecksum = Join-Path $TmpDir "$Filename.sha256"

    Write-Host "Downloading sonar-secrets from:"
    Get-RemoteFile -Url $Url -Dest $TmpBin

    Write-Host "Downloading SHA256 checksum from:"
    Get-RemoteFile -Url $ChecksumUrl -Dest $TmpChecksum

    Test-Sha256 -File $TmpBin -ChecksumFile $TmpChecksum

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir | Out-Null
    }

    Move-Item -Path $TmpBin -Destination $Dest -Force
    Write-Host "Installed sonar to: $Dest"

    Write-Host ''
    Write-Host "To run 'sonar' from anywhere, $InstallDir needs to be on your PATH."
    Write-Host 'The installer can add it to your user PATH automatically (no admin rights required).'
    $Answer = Read-Host 'Would you like to do that now? [y/N]'

    if ($Answer.Trim().ToLower() -eq 'y') {
        Add-ToUserPath -Dir $InstallDir
    } else {
        Write-Host "Skipped. To add it manually, run:"
        Write-Host "  [Environment]::SetEnvironmentVariable('PATH', `"$InstallDir;`$env:PATH`", 'User')"
    }

    Write-Host ''
    Write-Host 'Installation complete.'
    Write-Host 'To use sonar in your current session, run:'
    Write-Host "  `$env:PATH = `"$InstallDir;`$env:PATH`""
}
finally {
    Remove-Item -Recurse -Force -Path $TmpDir -ErrorAction SilentlyContinue
}
