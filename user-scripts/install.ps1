#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDir = '',
    [string]$Distribution = 'standalone',
    [switch]$Force,
    [string]$Version = '',
    [string]$ArtifactBaseUrl = ''
)

$IsCustomInstallDir = $PSBoundParameters.ContainsKey('InstallDir')
$ErrorActionPreference = 'Stop'
# Disable the PowerShell progress bar: in Windows PowerShell 5.1 it makes
# Invoke-WebRequest 10-50x slower for non-trivial downloads (the CLI binary
# is ~100 MB, so this takes the download from ~60s down to a few seconds).
$ProgressPreference = 'SilentlyContinue'

$DefaultInstallDir = Join-Path $env:LOCALAPPDATA 'sonarqube-cli\bin'
if (-not $InstallDir) {
    $InstallDir = $DefaultInstallDir
}
$BinaryName = 'sonar.exe'
$BaseUrl    = if ($ArtifactBaseUrl) { $ArtifactBaseUrl } else { 'https://binaries.sonarsource.com/Distribution/sonarqube-cli' }
$Platform   = 'windows-x86-64'
# Older self-update implementations scrape a literal `$SonarVersion = "XXX"` from
# this file before executing it. Keep this compatibility marker present, but unused:
# the real version now comes from stable.version at runtime. Release automation
# keeps this marker aligned with the latest released CLI version.
$SonarVersion = "1.2.0.3278"

function Resolve-LatestVersion {
    $Version = (Invoke-WebRequest -Uri "$BaseUrl/stable.version" -UseBasicParsing).Content.Trim()
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


function Add-ToPath {
    param([string]$Dir)

    # When installing to a non-default (system) directory, update Machine PATH so all
    # users pick it up. Requires elevation — the MDM/SYSTEM context always has it.
    $isMachine = $InstallDir -ne $DefaultInstallDir

    if ($isMachine) {
        # Read Machine PATH directly from the registry to avoid expanding REG_EXPAND_SZ
        # entries (e.g. %SystemRoot%\system32). GetEnvironmentVariable() expands them and
        # SetEnvironmentVariable() writes back as REG_SZ, which would collapse those
        # variables into literal paths and permanently corrupt the system PATH.
        $regPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
        $CurrentPath = (Get-ItemProperty -Path $regPath -Name Path -ErrorAction Stop).Path
        $UserPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
        $AllEntries = ($CurrentPath -split ';') + (if ($UserPath) { $UserPath -split ';' } else { @() })
        if ($AllEntries -contains $Dir) {
            Write-Host "PATH already contains the install directory, skipping."
            return
        }
        try {
            Set-ItemProperty -Path $regPath -Name Path -Value ($Dir + ";" + $CurrentPath) -Type ExpandString
            Write-Host "Added to Machine PATH: $Dir"
        } catch {
            Write-Warning "Could not update Machine PATH (elevation required): add '$Dir' to PATH manually."
        }
    } else {
        $CurrentPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
        if ($CurrentPath -split ';' -contains $Dir) {
            Write-Host "PATH already contains the install directory, skipping."
            return
        }
        try {
            [Environment]::SetEnvironmentVariable('PATH', "$Dir;$CurrentPath", 'User')
            Write-Host "Added to User PATH: $Dir"
        } catch {
            Write-Warning "Could not update User PATH: add '$Dir' to PATH manually."
        }
    }
}

# --- Main ---

if ($Version) {
    $SonarVersion = $Version
    Write-Host "Target version: $SonarVersion"
} else {
    $SonarVersion = Resolve-LatestVersion
    Write-Host "Latest version: $SonarVersion"
}

$Dest = Join-Path $InstallDir $BinaryName

# Skip download if the binary at the target path is already at the latest version.
# Skipped when -InstallDir is provided: the caller controls the target location and
# must get the correctly-flavored binary (e.g. MDM distribution), regardless of version.
if (-not $IsCustomInstallDir -and -not $Force -and (Test-Path $Dest)) {
    $TargetSemver = ($SonarVersion -split '\.' | Select-Object -First 3) -join '.'
    $InstalledVersion = ''
    $output = & $Dest --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $output) {
        $InstalledVersion = (($output.Trim() -split '\.') | Select-Object -First 3) -join '.'
    }
    if ($InstalledVersion -eq $TargetSemver) {
        Write-Host "Already at version $SonarVersion, nothing to do."
        Add-ToPath -Dir $InstallDir
        exit 0
    }
}

$DistPrefix   = if ($Distribution -ne 'standalone') { "$Distribution-" } else { '' }
$Filename     = "sonarqube-cli-$SonarVersion-${DistPrefix}$Platform.exe"
$Url          = "$BaseUrl/$SonarVersion/windows/$Filename"

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $TmpDir | Out-Null

try {
    $TmpBin = Join-Path $TmpDir $Filename

    Write-Host "Downloading sonarqube-cli from:"
    Get-RemoteFile -Url $Url -Dest $TmpBin

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir | Out-Null
    }

    Copy-Item -Path $TmpBin -Destination $Dest -Force
    Write-Host "Installed sonar to: $Dest"

    Add-ToPath -Dir $InstallDir

    Write-Host ''
    Write-Host 'Installation complete!'
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
