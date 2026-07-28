#Requires -Version 5.1
# 1. Always installs the latest CLI to C:\Program Files\sonarqube-cli\bin.
# 2. For every local user that has a standalone install, replaces it with a
#    symbolic link to the MDM binary so PATH order cannot override it.
# Self-contained: no external scripts are downloaded or executed.
# SONARQUBE_CLI_APPROVED_VERSION -- optional JumpCloud variable; pins the install version instead of
#                     using stable.version.
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$MdmBinary       = 'C:\Program Files\sonarqube-cli\bin\sonar.exe'
$StandaloneRel   = 'AppData\Local\sonarqube-cli\bin\sonar.exe'
$ArtifactBaseUrl = 'https://binaries.sonarsource.com/Distribution/sonarqube-cli'
# JumpCloud-specific: {{SONARQUBE_CLI_APPROVED_VERSION}} is replaced with the Custom Variable's
# value (quoted) at runtime -- not a real $env: variable. Other MDM systems may inject this
# differently.
$ApprovedVersionOverride = {{SONARQUBE_CLI_APPROVED_VERSION}}
if ($ApprovedVersionOverride -isnot [string]) { $ApprovedVersionOverride = $null }
# Defense-in-depth: a valid version can't contain quotes/$()/backticks, so this closes off
# variable-substitution injection regardless of how the MDM tool quotes Custom Variables.
if ($ApprovedVersionOverride -and $ApprovedVersionOverride -notmatch '^[0-9][0-9.]*$') {
    Write-Error "SONARQUBE_CLI_APPROVED_VERSION has an invalid format: $ApprovedVersionOverride"
    exit 1
}
$Platform        = 'windows-x86-64'
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

function Add-ToMachinePath {
    param([string]$Dir)
    # Use the [Environment] APIs rather than Get-ItemProperty/Set-ItemProperty: Get-ItemProperty
    # expands REG_EXPAND_SZ values (e.g. %SystemRoot%), so writing that back would permanently
    # bake resolved paths into the machine PATH and lose the original %variable% references.
    $current = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    if (($current -split ';') -contains $Dir) {
        Write-Output 'PATH already contains the install directory, skipping.'
        return
    }
    $newPath = $current.TrimEnd(';') + ';' + $Dir
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'Machine')
    Write-Output "Added to Machine PATH: $Dir"
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

$version = Get-TargetVersion
Write-Host "Target version: $version"

Install-SonarBinary -Version $version -Dest $MdmBinary
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
