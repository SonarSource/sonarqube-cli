// Hooks installation - install Claude Code hooks (cross-platform)

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import logger from '../lib/logger.js';

const CLAUDE_DIR = '.claude';
const HOOKS_DIR = 'hooks';
const SETTINGS_FILE = 'settings.local.json';

export type HookType = 'prompt' | 'cli';

interface HookConfig {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout: number;
  }>;
}

interface PermissionsConfig {
  allow: string[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: {
    [eventType: string]: HookConfig[];
  };
  permissions?: PermissionsConfig;
  mcpServers?: unknown;
  [key: string]: unknown;
}

/**
 * Get platform identifier
 */
function getPlatform(): 'windows' | 'unix' {
  return platform() === 'win32' ? 'windows' : 'unix';
}

/**
 * Get script extension based on platform
 */
function getScriptExtension(): string {
  return getPlatform() === 'windows' ? '.ps1' : '.sh';
}

/**
 * Install hooks for SonarQube analysis (cross-platform)
 */
export async function installHooks(
  projectRoot: string,
  hookType: HookType = 'prompt'
): Promise<void> {
  const claudePath = join(projectRoot, CLAUDE_DIR);

  // Create .claude directory
  if (!existsSync(claudePath)) {
    mkdirSync(claudePath, { recursive: true });
  }

  // Create hooks subdirectory
  const hooksPath = join(claudePath, HOOKS_DIR);
  if (!existsSync(hooksPath)) {
    mkdirSync(hooksPath, { recursive: true });
  }

  // Install hook script with platform-specific extension
  const extension = getScriptExtension();
  const scriptName = `sonar-prompt${extension}`;
  const scriptPath = join(hooksPath, scriptName);
  const scriptContent = getHookScriptContent(hookType);

  const fs = await import('node:fs/promises');

  if (getPlatform() === 'unix') {
    // Unix: set executable permissions
    await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });
  } else {
    // Windows: no special permissions
    await fs.writeFile(scriptPath, scriptContent);
  }

  logger.info(`   ✓ Installed hook script: ${scriptPath}`);

  // Configure hooks in settings.local.json
  await configureHooksSettings(claudePath, scriptName);

  logger.info('   ✓ Hooks configured');
}

/**
 * Get hook script content based on type and platform
 */
function getHookScriptContent(hookType: HookType): string {
  const isWindows = getPlatform() === 'windows';

  if (hookType === 'cli') {
    return isWindows ? getHookCLITemplateWindows() : getHookCLITemplateUnix();
  }
  return isWindows ? getHookPromptTemplateWindows() : getHookPromptTemplateUnix();
}

/**
 * Configure hooks in settings.local.json (cross-platform paths)
 */
async function configureHooksSettings(
  claudePath: string,
  scriptName: string
): Promise<void> {
  const settingsPath = join(claudePath, SETTINGS_FILE);

  let settings: ClaudeSettings;

  // Load existing settings or create new
  if (existsSync(settingsPath)) {
    const fs = await import('node:fs/promises');
    const data = await fs.readFile(settingsPath, 'utf-8');
    settings = JSON.parse(data);
  } else {
    settings = { hooks: {} };
  }

  // Remove old project-specific MCP configuration (moved to global config)
  if (settings.mcpServers) {
    delete settings.mcpServers;
  }

  // Ensure hooks exist
  settings.hooks ??= {};

  // Build cross-platform command path using path.join normalization
  const commandPath = join('.claude', 'hooks', scriptName);

  // Add PostToolUse hook with normalized path
  settings.hooks.PostToolUse = [
    {
      matcher: 'Edit|Write',
      hooks: [
        {
          type: 'command',
          command: commandPath,
          timeout: 120
        }
      ]
    }
  ];

  // Ensure permissions section exists
  settings.permissions ??= {allow: []};
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }

  // Save settings
  const fs = await import('node:fs/promises');
  const data = JSON.stringify(settings, null, 2);
  await fs.writeFile(settingsPath, data, 'utf-8');
}

/**
 * Check if hooks are installed
 */
export async function areHooksInstalled(projectRoot: string): Promise<boolean> {
  const settingsPath = join(projectRoot, CLAUDE_DIR, SETTINGS_FILE);

  if (!existsSync(settingsPath)) {
    return false;
  }

  try {
    const fs = await import('node:fs/promises');
    const data = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(data);

    // Check if PostToolUse hook is actually configured
    return !!(settings.hooks?.PostToolUse && Array.isArray(settings.hooks.PostToolUse) && settings.hooks.PostToolUse.length > 0);
  } catch {
    return false;
  }
}

/**
 * Unix hook template for prompt-based analysis (bash)
 */
function getHookPromptTemplateUnix(): string {
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
function getHookCLITemplateUnix(): string {
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
function getHookPromptTemplateWindows(): string {
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
function getHookCLITemplateWindows(): string {
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
 * Install sonar-secrets hooks to project (cross-platform)
 * Attempts to copy hooks from ~/.claude/hooks/sonar-secrets
 * Falls back to creating hooks dynamically if source doesn't exist
 * Registers hooks in .claude/settings.json
 */
export async function installSecretScanningHooks(projectRoot: string): Promise<void> {
  try {
    const { homedir } = await import('node:os');
    const fs = await import('node:fs/promises');
    const claudePath = join(projectRoot, CLAUDE_DIR);
    const hooksPath = join(claudePath, HOOKS_DIR);

    // Create hooks directory
    mkdirSync(hooksPath, { recursive: true });

    const sourceSecretsDir = join(homedir(), '.claude', 'hooks', 'sonar-secrets');
    const targetSecretsDir = join(hooksPath, 'sonar-secrets');
    const targetScriptsDir = join(targetSecretsDir, 'scripts');

    mkdirSync(targetScriptsDir, { recursive: true });

    const isWindows = getPlatform() === 'windows';
    const scriptExt = getScriptExtension();

    // Try to copy existing hooks first
    if (existsSync(sourceSecretsDir)) {
      const copyDirRecursive = async (src: string, dest: string): Promise<void> => {
        mkdirSync(dest, { recursive: true });
        const entries = await fs.readdir(src, { withFileTypes: true });

        for (const entry of entries) {
          const srcPath = join(src, entry.name);
          const destPath = join(dest, entry.name);

          if (entry.isDirectory()) {
            await copyDirRecursive(srcPath, destPath);
          } else {
            await fs.copyFile(srcPath, destPath);
          }
        }
      };

      await copyDirRecursive(sourceSecretsDir, targetSecretsDir);
    } else {
      // Generate hooks dynamically if source doesn't exist
      const preTool = isWindows ? getSecretPreToolTemplateWindows() : getSecretPreToolTemplateUnix();
      const prompt = isWindows ? getSecretPromptTemplateWindows() : getSecretPromptTemplateUnix();

      const preToolPath = join(targetScriptsDir, `pretool-secrets${scriptExt}`);
      const promptPath = join(targetScriptsDir, `prompt-secrets${scriptExt}`);

      if (!isWindows) {
        // Unix: set executable permissions
        await fs.writeFile(preToolPath, preTool, { mode: 0o755 });
        await fs.writeFile(promptPath, prompt, { mode: 0o755 });
      } else {
        // Windows: no special permissions
        await fs.writeFile(preToolPath, preTool);
        await fs.writeFile(promptPath, prompt);
      }
    }

    // Register hooks in settings.json
    const settingsPath = join(claudePath, SETTINGS_FILE);
    let settings: ClaudeSettings = { hooks: {} };

    if (existsSync(settingsPath)) {
      const data = await fs.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(data);
    }

    // Ensure hooks section exists
    settings.hooks ??= {};

    // Add sonar-secrets hooks to settings
    settings.hooks.PreToolUse = [
      {
        matcher: 'Read',
        hooks: [
          {
            type: 'command',
            command: join('.claude', 'hooks', 'sonar-secrets', 'scripts', `pretool-secrets${scriptExt}`),
            timeout: 60
          }
        ]
      }
    ];

    // UserPromptSubmit for prompt scanning
    settings.hooks.UserPromptSubmit = [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: join('.claude', 'hooks', 'sonar-secrets', 'scripts', `prompt-secrets${scriptExt}`),
            timeout: 60
          }
        ]
      }
    ];

    // Save updated settings
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    logger.debug('Secret scanning hooks installed to project');
  } catch (error) {
    logger.debug(`Failed to install secret scanning hooks: ${(error as Error).message}`);
    // Non-critical - don't fail if hooks installation fails
  }
}

/**
 * Unix template for sonar-secrets PreToolUse hook (bash)
 */
function getSecretPreToolTemplateUnix(): string {
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
function getSecretPreToolTemplateWindows(): string {
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
function getSecretPromptTemplateUnix(): string {
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

# Scan prompt for secrets
echo -n "$prompt" | sonar secret check --stdin > /dev/null 2>&1
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
function getSecretPromptTemplateWindows(): string {
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

try {
    $prompt | & sonar secret check --stdin | Out-Null
    $exitCode = $LASTEXITCODE
} catch {
    exit 0
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
