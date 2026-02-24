// Hook script templates for Claude Code integration

/**
 * Unix template for sonar-secrets PreToolUse hook (bash)
 */
export function getSecretPreToolTemplateUnix(): string {
  return String.raw`#!/bin/bash
# PreToolUse hook: Scan files before reading to prevent secret leakage
# Blocks file reads if secrets are detected

if ! command -v sonar &> /dev/null; then
  exit 0
fi

# Read JSON from stdin
stdin_data=$(cat)

# Extract tool_name and file_path using sed (no jq dependency)
tool_name=$(echo "$stdin_data" | sed -n 's/.*"tool_name":"\([^"]*\)".*/\1/p' | head -1)

if [ "$tool_name" != "Read" ]; then
  exit 0
fi

# Extract file_path from tool_input
file_path=$(echo "$stdin_data" | sed -n 's/.*"tool_input":\s*{\([^}]*\)}.*/\1/p' | \
  sed -n 's/.*"file_path":"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
  exit 0
fi

# Scan file for secrets
sonar analyze --file "$file_path" > /dev/null 2>&1
exit_code=$?

if [ $exit_code -eq 51 ]; then
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
    & sonar analyze --file $filePath | Out-Null
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

if [ -z "$prompt" ]; then
  exit 0
fi

# Create temporary file with prompt content (stdin is already occupied by hook input)
temp_file=$(mktemp)
trap "rm -f $temp_file" EXIT

echo -n "$prompt" > "$temp_file"

# Scan prompt for secrets (using file instead of stdin pipe)
sonar analyze --file "$temp_file" > /dev/null 2>&1
exit_code=$?

if [ $exit_code -eq 51 ]; then
  # Secrets found - block prompt
  reason="Sonar detected secrets in prompt"
  echo "{\"decision\":\"block\",\"reason\":\"$reason\"}"
  exit 0
fi

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
    & sonar analyze --file $tempFile | Out-Null
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
