/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

// Hook script templates for Claude Code integration (Windows; Unix shared in _common)

export {
  getSecretPreToolTemplateUnix,
  getSecretPromptTemplateUnix,
  getSqaaPostToolTemplateUnix,
} from '../_common/unix-agent-hook-templates';

/**
 * Windows template for sonar-secrets PreToolUse hook (PowerShell)
 */
export function getSecretPreToolTemplateWindows(): string {
  return String.raw`param(
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputData
)

try {
    $input = $InputData | ConvertFrom-Json -ErrorAction Stop
} catch {
    exit 0
}

$toolName = $input.tool_name
$filePath = $input.tool_input.file_path

if ($toolName -ne "Read" -or [string]::IsNullOrEmpty($filePath) -or -not (Test-Path $filePath)) {
    exit 0
}

if (-not (Get-Command sonar -ErrorAction SilentlyContinue)) {
    exit 0
}

try {
    & sonar analyze secrets $filePath | Out-Null
    $exitCode = $LASTEXITCODE
} catch {
    exit 0
}

if ($exitCode -eq 51) {
    $reason = "Sonar detected secrets in file: $filePath"
    $response = @{
        hookSpecificOutput = @{
            hookEventName = "PreToolUse"
            permissionDecision = "deny"
            permissionDecisionReason = $reason
        }
    } | ConvertTo-Json
    Write-Host $response
}

exit 0
`;
}

/**
 * Windows template for SQAA PostToolUse hook (PowerShell)
 */
export function getSqaaPostToolTemplateWindows(projectKey: string): string {
  return String.raw`param(
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputData
)

try {
    $input = $InputData | ConvertFrom-Json -ErrorAction Stop
} catch {
    exit 0
}

$toolName = $input.tool_name
$filePath = $input.tool_input.file_path

if (($toolName -ne "Edit" -and $toolName -ne "Write") -or [string]::IsNullOrEmpty($filePath) -or -not (Test-Path $filePath)) {
    exit 0
}

if (-not (Get-Command sonar -ErrorAction SilentlyContinue)) {
    exit 0
}

try {
    $output = & sonar analyze sqaa --file $filePath --project ${projectKey} 2>$null | Out-String
    $result = @{
        hookSpecificOutput = @{
            hookEventName   = "PostToolUse"
            additionalContext = $output.Trim()
        }
    } | ConvertTo-Json -Compress
    Write-Output $result
} catch {
    # Non-blocking
}

exit 0
`;
}

/**
 * Windows template for sonar-secrets UserPromptSubmit hook (PowerShell)
 */
export function getSecretPromptTemplateWindows(): string {
  return String.raw`param(
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputData
)

try {
    $input = $InputData | ConvertFrom-Json -ErrorAction Stop
} catch {
    exit 0
}

$prompt = $input.prompt
if ([string]::IsNullOrEmpty($prompt) -and $null -ne $input.payload) {
    $prompt = $input.payload.prompt
}

if ([string]::IsNullOrEmpty($prompt)) {
    exit 0
}

if (-not (Get-Command sonar -ErrorAction SilentlyContinue)) {
    exit 0
}

# Create temporary file with prompt content (stdin is already occupied by hook input)
$tempFile = [System.IO.Path]::GetTempFileName()

try {
    $prompt | Set-Content -Path $tempFile -NoNewline -Encoding UTF8

    # Scan prompt for secrets (using file instead of stdin pipe)
    & sonar analyze secrets $tempFile | Out-Null
    $exitCode = $LASTEXITCODE
} catch {
    $exitCode = 0
} finally {
    if (Test-Path $tempFile) {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
}

if ($exitCode -eq 51) {
    $reason = "Sonar detected secrets in prompt"
    $response = @{
        decision = "block"
        reason = $reason
    } | ConvertTo-Json
    Write-Host $response
}

exit 0
`;
}
