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

// Hook script templates for Claude Code integration

/**
 * Unix template for sonar-secrets PreToolUse hook (bash)
1 */
export function getSecretPreToolTemplateUnix(): string {
  return String.raw`#!/bin/bash
# PreToolUse hook: Scan files before reading to prevent secret leakage
# Blocks file reads if secrets are detected

if ! command -v sonar &> /dev/null; then
  exit 0
fi

# Read JSON from stdin and extract fields using grep/cut (no external runtimes required)
stdin_data=$(cat)
tool_name=$(echo "$stdin_data" | grep -o '"tool_name":"[^"]*"' | cut -d'"' -f4)

if [[ "$tool_name" != "Read" ]]; then
  exit 0
fi

file_path=$(echo "$stdin_data" | grep -o '"file_path":"[^"]*"' | cut -d'"' -f4)

if [[ -z "$file_path" ]] || [[ ! -f "$file_path" ]]; then
  exit 0
fi

# Scan file for secrets
sonar analyze secrets "$file_path" > /dev/null 2>&1
exit_code=$?

if [[ $exit_code -eq 51 ]]; then
  # Secrets found - deny file read
  reason="Sonar detected secrets in file: $file_path"
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"$reason\"}}"
  exit 0
fi

exit 0
`;
}

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
 * Unix template for sonar-secrets UserPromptSubmit hook (bash)
 */
export function getSecretPromptTemplateUnix(): string {
  return String.raw`#!/bin/bash
# UserPromptSubmit hook: Scan prompt for secrets before sending

if ! command -v sonar &> /dev/null; then
  exit 0
fi

# Read JSON from stdin
stdin_data=$(cat)

# Extract prompt field using sed
prompt=$(echo "$stdin_data" | sed -n 's/.*"prompt":"\([^"]*\)".*/\1/p' | head -1)

if [[ -z "$prompt" ]]; then
  exit 0
fi

# Create temporary file with prompt content (stdin is already occupied by hook input)
temp_file=$(mktemp)
trap "rm -f $temp_file" EXIT

echo -n "$prompt" > "$temp_file"

# Scan prompt for secrets (using file instead of stdin pipe)
sonar analyze secrets "$temp_file" > /dev/null 2>&1
exit_code=$?

if [[ $exit_code -eq 51 ]]; then
  # Secrets found - block prompt
  reason="Sonar detected secrets in prompt"
  echo "{\"decision\":\"block\",\"reason\":\"$reason\"}"
  exit 0
fi

exit 0
`;
}

/**
 * Unix template for A3S PostToolUse hook (bash)
 * Runs after Edit/Write — analyzes the modified file with A3S.
 */
export function getA3sPostToolTemplateUnix(projectKey: string): string {
  return String.raw`#!/bin/bash
# PostToolUse hook: Run A3S analysis on edited/written files

if ! command -v sonar &> /dev/null; then
  exit 0
fi

# Read JSON from stdin and extract fields using grep/cut (no external runtimes required)
stdin_data=$(cat)
tool_name=$(echo "$stdin_data" | grep -o '"tool_name":"[^"]*"' | cut -d'"' -f4)

if [[ "$tool_name" != "Edit" ]] && [[ "$tool_name" != "Write" ]]; then
  exit 0
fi

file_path=$(echo "$stdin_data" | grep -o '"file_path":"[^"]*"' | cut -d'"' -f4)

if [[ -z "$file_path" ]] || [[ ! -f "$file_path" ]]; then
  exit 0
fi

# Capture A3S analysis output and pass it to Claude via additionalContext
output=$(sonar analyze a3s --file "$file_path" --project ${projectKey} 2>/dev/null)

# JSON-escape the output using awk (no external runtimes required)
escaped=$(printf '%s' "$output" | awk 'BEGIN{ORS=""} {gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, "\\r"); if(NR>1) printf "\\n"; print}')

printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$escaped"

exit 0
`;
}

/**
 * Windows template for A3S PostToolUse hook (PowerShell)
 */
export function getA3sPostToolTemplateWindows(projectKey: string): string {
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
    $output = & sonar analyze a3s --file $filePath --project ${projectKey} 2>$null | Out-String
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
