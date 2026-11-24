#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [Parameter(Mandatory = $true)]
    [string]$ApiKey
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Assert-LastExit {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE"
    }
}

if ($Version -notmatch '^[0-9]+(\.[0-9]+){2,3}$') {
    throw "Refusing to publish unexpected version: $Version"
}

Write-Host "::add-mask::$ApiKey"

if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    throw 'Chocolatey is not installed on this runner.'
}

$baseUrl = "https://binaries.sonarsource.com/Distribution/sonarqube-cli/$Version/windows"
$name = "sonarqube-cli-$Version-windows-x86-64.exe"
$exeUrl = "$baseUrl/$name"
$shaUrl = "$exeUrl.sha256"

$work = Join-Path $PSScriptRoot 'work'
if (Test-Path $work) {
    Remove-Item $work -Recurse -Force
}
$tools = Join-Path $work 'tools'
New-Item -ItemType Directory -Path $tools | Out-Null

Copy-Item (Join-Path $PSScriptRoot 'sonarqube-cli.nuspec') $work
Copy-Item (Join-Path $PSScriptRoot 'tools\LICENSE.txt') $tools
Copy-Item (Join-Path $PSScriptRoot 'tools\VERIFICATION.txt') $tools

$exePath = Join-Path $env:TEMP $name
Write-Host "Downloading $exeUrl"
Invoke-WebRequest -Uri $exeUrl -OutFile $exePath -UseBasicParsing

$raw = (Invoke-WebRequest -Uri $shaUrl -UseBasicParsing).Content
if ($raw -is [byte[]]) {
    $raw = [System.Text.Encoding]::UTF8.GetString($raw)
}
$expected = (($raw.Trim() -split '\s+')[0]).ToLower()
$actual = (Get-FileHash -Path $exePath -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) {
    throw "SHA256 mismatch for $exeUrl`n  expected: $expected`n  actual:   $actual"
}

Copy-Item $exePath (Join-Path $tools 'sonar.exe')

$utf8 = New-Object System.Text.UTF8Encoding $false
foreach ($relative in @('sonarqube-cli.nuspec', 'tools\VERIFICATION.txt')) {
    $path = Join-Path $work $relative
    $content = (Get-Content -Path $path -Raw) -replace '__VERSION__', $Version -replace '__SHA256__', $expected
    [System.IO.File]::WriteAllText($path, $content, $utf8)
}

$installed = $false
$packageLib = Join-Path $env:ChocolateyInstall 'lib\sonarqube-cli'
Push-Location $work
try {
    choco pack
    Assert-LastExit 'choco pack'

    $nupkg = Get-Item -Path "sonarqube-cli.$Version.nupkg"
    if ($nupkg.Length -gt 200MB) {
        throw "Package is $($nupkg.Length) bytes, over the 200 MB community feed limit"
    }

    choco install sonarqube-cli --source . -y --no-progress
    $installExit = $LASTEXITCODE
    $installed = Test-Path $packageLib
    if ($installExit -ne 0) {
        throw "choco install failed with exit code $installExit"
    }

    $env:Path = "$env:ChocolateyInstall\bin;" + $env:Path
    $command = Get-Command sonar -ErrorAction Stop
    Write-Host "sonar executable: $($command.Source)"
    $embedded = Join-Path $packageLib 'tools\sonar.exe'
    if (-not (Test-Path $embedded)) {
        throw "Embedded binary missing at $embedded"
    }
    Write-Host "embedded binary: $embedded"

    & sonar --version
    Assert-LastExit 'sonar --version'

    choco uninstall sonarqube-cli -y --no-progress
    Assert-LastExit 'choco uninstall'
    $installed = $false

    $shim = Join-Path $env:ChocolateyInstall 'bin\sonar.exe'
    if (Test-Path $shim) {
        throw "Shim still present at $shim"
    }

    choco push $nupkg.FullName --source 'https://push.chocolatey.org/' --api-key $ApiKey
    Assert-LastExit 'choco push'
}
finally {
    if ($installed) {
        choco uninstall sonarqube-cli -y --no-progress
    }
    Pop-Location
}
