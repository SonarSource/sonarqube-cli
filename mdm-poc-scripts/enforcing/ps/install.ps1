#Requires -Version 5.1
# JumpCloud Command: IS > Prod > Windows > Deploy SonarQube CLI (enforcing)
# 1. Always installs the latest CLI to C:\Program Files\sonarqube-cli\bin.
# 2. For every local user that has a standalone install, replaces it with a
#    symbolic link to the MDM binary so PATH order cannot override it.
# Self-contained: no external scripts are downloaded or executed.
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$MdmBinary       = 'C:\Program Files\sonarqube-cli\bin\sonar.exe'
$StandaloneRel   = 'AppData\Local\sonarqube-cli\bin\sonar.exe'
$ArtifactBaseUrl = if ($env:ARTIFACT_BASE_URL) { $env:ARTIFACT_BASE_URL } else { 'https://binaries.sonarsource.com/Distribution/sonarqube-cli' }
$Platform        = 'windows-x86-64'
$env:PATH        = "$(Split-Path $MdmBinary);$env:PATH"

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

# -- Step 1: install MDM binary ------------------------------------------------

Write-Host "Installing SonarQube CLI to $MdmBinary..."

$version = Get-LatestVersion
Write-Host "Latest version: $version"

Install-SonarBinary -Version $version -Dest $MdmBinary
Test-BinarySha256   -Binary $MdmBinary -Version $version
Add-ToMachinePath   -Dir (Split-Path $MdmBinary)

# -- Step 2: symlink standalone path -> MDM binary for each local user ----------
# Only acts when the standalone binary already exists.
# A user's sonar self-update will overwrite the symlink with a real binary;
# the daily MDM run re-symlinks it on the next execution.

Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $standalone = Join-Path $_.FullName $StandaloneRel
    if (-not (Test-Path $standalone) -and -not (Test-Path $standalone -PathType Leaf)) { return }

    $item = Get-Item $standalone -ErrorAction SilentlyContinue
    if ($item -and $item.LinkType -eq 'SymbolicLink' -and $item.Target -eq $MdmBinary) {
        Write-Host "  $standalone -- already symlinked, skipping"
        return
    }

    Write-Host "  $standalone -- replacing with symlink to $MdmBinary"
    if ($item) { Remove-Item $standalone -Force }
    New-Item -ItemType SymbolicLink -Path $standalone -Target $MdmBinary -Force | Out-Null
}

# -- Verify --------------------------------------------------------------------

Write-Host "MDM sonar: $MdmBinary -- $(& $MdmBinary --version)"
$sonarWhere = try { (Get-Command sonar -ErrorAction Stop).Source } catch { 'not found' }
Write-Host "where sonar: $sonarWhere"
if ($sonarWhere -ne 'not found') { Write-Host "sonar -v:    $(sonar --version)" }
