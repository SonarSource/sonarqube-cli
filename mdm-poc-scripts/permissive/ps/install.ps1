#Requires -Version 5.1
# JumpCloud Command: IS > Prod > Windows > Deploy SonarQube CLI
# Runs daily as SYSTEM. Installs the CLI to C:\Program Files\sonarqube-cli\bin on first run only.
# Upgrades and downgrades are handled by the MDM update script -- this script does not touch
# an existing binary. Self-contained: no external scripts are downloaded or executed.
$ErrorActionPreference = 'Stop'
# Disable progress bar: dramatically speeds up Invoke-WebRequest on PS 5.1.
$ProgressPreference = 'SilentlyContinue'

$MdmBinary       = 'C:\Program Files\sonarqube-cli\bin\sonar.exe'
$ArtifactBaseUrl = if ($env:ARTIFACT_BASE_URL) { $env:ARTIFACT_BASE_URL } else { 'https://binaries.sonarsource.com/Distribution/sonarqube-cli' }
$Platform        = 'windows-x86-64'

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

function Add-ToMachinePath {
    param([string]$Dir)
    $regPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'
    $current = (Get-ItemProperty -Path $regPath -Name Path).Path
    if (($current -split ';') -contains $Dir) {
        Write-Host 'PATH already contains the install directory, skipping.'
        return
    }
    $newPath = $current + ';' + $Dir
    Set-ItemProperty -Path $regPath -Name Path -Value $newPath -Type ExpandString
    Write-Host "Added to Machine PATH: $Dir"
    # Broadcast environment change so explorer and running shells pick up the new PATH
    # without requiring a logoff/logon.
    $sig = '[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
    Add-Type -MemberDefinition $sig -Name 'Win32SendMsg' -Namespace 'NativeMethods' -ErrorAction SilentlyContinue
    $result = [UIntPtr]::Zero
    [NativeMethods.Win32SendMsg]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
}

# -- Main ----------------------------------------------------------------------

if (Test-Path $MdmBinary) {
    Write-Host "SonarQube CLI already present at $MdmBinary -- skipping (upgrades via MDM update script)."
    exit 0
}

Write-Host "SonarQube CLI not found -- installing to $MdmBinary..."

$version = Get-LatestVersion
Write-Host "Latest version: $version"

Install-SonarBinary -Version $version -Dest $MdmBinary
Test-BinarySha256   -Binary $MdmBinary -Version $version
Add-ToMachinePath   -Dir (Split-Path $MdmBinary)

Write-Host "MDM sonar: $MdmBinary -- $(& $MdmBinary --version)"
