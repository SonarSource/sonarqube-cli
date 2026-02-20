// Hook script templates for Claude Code integration

/**
 * Unix hook template for prompt-based analysis (bash)
 */
export function getHookPromptTemplateUnix(): string {
  return String.raw`#!/bin/bash
# SonarQube Analysis Hook for Claude Code
# This hook prompts the agent to analyze files after Edit/Write operations
# Platform: Unix/Linux/macOS

set -e

# Read JSON from stdin
INPUT=$(cat)

# Parse JSON using grep/sed instead of jq for compatibility
TOOL=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*' | head -1 | cut -d'"' -f4)
FILE=$(echo "$INPUT" | grep -o '"file_path":"[^"]*' | head -1 | cut -d'"' -f4)

# Skip if no file specified
[ -z "$FILE" ] && exit 0

# Check if file is in supported languages
case "$FILE" in
    *.java|*.js|*.jsx|*.ts|*.tsx|*.py|*.go|*.rb|*.php|*.cs|*.cpp|*.c|*.h|*.hpp)
        # File is in supported language, continue
        ;;
    *)
        # Not a supported file type, skip
        exit 0
        ;;
esac

# Output prompt for the agent as JSON
PROMPT="╔══════════════════════════════════════════════════════════╗
║        SONARQUBE ANALYSIS REQUIRED                       ║
╚══════════════════════════════════════════════════════════╝

You just modified: $FILE

You MUST analyze this file for code quality issues by running:
  sonar verify --file $FILE

You MUST fix ALL issues found in this file:
- Fix ALL bugs and security vulnerabilities (critical priority)
- Fix ALL code smells and maintainability issues
- Fix ALL issues even if they existed before your changes
- Fix ALL issues even if they are minor
- Do not skip any issues

The file must be completely clean before you proceed to the next task."

# Output as JSON (compatible format)
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "$(echo "$PROMPT" | sed 's/"/\\"/g' | tr '\n' ' ')"
  }
}
EOF

# Always exit 0 to never block Claude Code
exit 0
`;
}

/**
 * Unix hook template for CLI-based analysis (bash)
 */
export function getHookCLITemplateUnix(): string {
  return `#!/bin/bash
# SonarQube Hook - CLI Mode
# This hook automatically runs SonarQube analysis after code changes
# Platform: Unix/Linux/macOS

# Read JSON from stdin
INPUT=$(cat)

# Parse JSON using grep/sed instead of jq
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*' | head -1 | cut -d'"' -f4)
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path":"[^"]*' | head -1 | cut -d'"' -f4)

# Only analyze if Edit or Write was used
if [ "$TOOL_NAME" != "Edit" ] && [ "$TOOL_NAME" != "Write" ]; then
  exit 0
fi

# Check if file exists and is a supported language
if [ -f "$FILE_PATH" ]; then
  # Check file extension (only analyze code files)
  EXT="\${FILE_PATH##*.}"
  case "$EXT" in
    js|ts|jsx|tsx|java|py|go|rb|php|cs|cpp|c|h|hpp)
      echo ""
      echo "🔍 Analyzing $FILE_PATH with SonarQube..."
      sonar verify --file "$FILE_PATH" || true
      ;;
    *)
      # Skip non-code files
      ;;
  esac
fi

exit 0
`;
}

/**
 * Windows hook template for prompt-based analysis (PowerShell)
 */
export function getHookPromptTemplateWindows(): string {
  return `#!/usr/bin/env pwsh
# SonarQube Analysis Hook for Claude Code
# This hook prompts the agent to analyze files after Edit/Write operations
# Platform: Windows

param(
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputData
)

# Parse JSON from stdin
try {
    $input = $InputData | ConvertFrom-Json -ErrorAction Stop
} catch {
    # Invalid JSON, skip
    exit 0
}

# Extract values
$toolName = $input.tool_name
$filePath = $input.tool_input.file_path

# Skip if no file specified
if ([string]::IsNullOrEmpty($filePath)) {
    exit 0
}

# Check if file is in supported languages
$supportedExtensions = @('java', 'js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rb', 'php', 'cs', 'cpp', 'c', 'h', 'hpp')
$fileExtension = [System.IO.Path]::GetExtension($filePath).TrimStart('.')

if ($supportedExtensions -notcontains $fileExtension) {
    exit 0
}

# Build the prompt message
$prompt = @"
╔══════════════════════════════════════════════════════════╗
║        SONARQUBE ANALYSIS REQUIRED                       ║
╚══════════════════════════════════════════════════════════╝

You just modified: $filePath

You MUST analyze this file for code quality issues by running:
  sonar verify --file $filePath

You MUST fix ALL issues found in this file:
- Fix ALL bugs and security vulnerabilities (critical priority)
- Fix ALL code smells and maintainability issues
- Fix ALL issues even if they existed before your changes
- Fix ALL issues even if they are minor
- Do not skip any issues

The file must be completely clean before you proceed to the next task.
"@

# Output as JSON
$output = @{
    hookSpecificOutput = @{
        hookEventName = "PostToolUse"
        additionalContext = $prompt
    }
}

$output | ConvertTo-Json -Depth 10 -EnumsAsStrings

# Always exit 0 to never block Claude Code
exit 0
`;
}

/**
 * Windows hook template for CLI-based analysis (PowerShell)
 */
export function getHookCLITemplateWindows(): string {
  return `#!/usr/bin/env pwsh
# SonarQube Hook - CLI Mode
# This hook automatically runs SonarQube analysis after code changes
# Platform: Windows

param(
    [Parameter(ValueFromPipeline = $true)]
    [string]$InputData
)

# Parse JSON from stdin
try {
    $input = $InputData | ConvertFrom-Json -ErrorAction Stop
} catch {
    # Invalid JSON, skip
    exit 0
}

# Extract values
$toolName = $input.tool_name
$filePath = $input.tool_input.file_path

# Only analyze if Edit or Write was used
if ($toolName -ne "Edit" -and $toolName -ne "Write") {
    exit 0
}

# Check if file exists
if (-Not (Test-Path $filePath -Type Leaf)) {
    exit 0
}

# Check file extension (only analyze code files)
$extension = [System.IO.Path]::GetExtension($filePath).TrimStart('.')
$supportedExtensions = @('js', 'ts', 'jsx', 'tsx', 'java', 'py', 'go', 'rb', 'php', 'cs', 'cpp', 'c', 'h', 'hpp')

if ($supportedExtensions -contains $extension) {
    Write-Host ""
    Write-Host "🔍 Analyzing $filePath with SonarQube..."

    # Run sonar verify (ignore errors to not block Claude Code)
    try {
        & sonar verify --file $filePath
    } catch {
        # Silently ignore errors
    }
}

exit 0
`;
}

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
sonar secret check --file "$file_path" > /dev/null 2>&1
exit_code=$?

if [ $exit_code -eq 1 ]; then
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
    & sonar secret check --file $filePath | Out-Null
    $exitCode = $LASTEXITCODE
} catch {
    exit 0
}

if ($exitCode -eq 1) {
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
sonar secret check --file "$temp_file" > /dev/null 2>&1
exit_code=$?

if [ $exit_code -eq 1 ]; then
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
    & sonar secret check --file $tempFile | Out-Null
    $exitCode = $LASTEXITCODE
} catch {
    $exitCode = 0
} finally {
    if (Test-Path $tempFile) {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
}

if ($exitCode -eq 1) {
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
