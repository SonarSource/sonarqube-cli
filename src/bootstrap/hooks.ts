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
