// Hooks installation - install Claude Code hooks

import { existsSync, mkdirSync, chmodSync } from 'fs';
import { join } from 'path';

const CLAUDE_DIR = '.claude';
const HOOKS_DIR = 'hooks';
const SETTINGS_FILE = 'settings.local.json';

export type HookType = 'prompt' | 'cli';

interface ClaudeSettings {
  hooks?: {
    [eventType: string]: Array<{
      matcher: string;
      hooks: Array<{
        type: string;
        command: string;
        timeout: number;
      }>;
    }>;
  };
  permissions?: {
    allow: string[];
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Install hooks for SonarQube analysis
 */
export async function installHooks(
  projectRoot: string,
  hookType: HookType = 'prompt'
): Promise<void> {
  const claudePath = join(projectRoot, CLAUDE_DIR);

  // Create .claude directory
  if (!existsSync(claudePath)) {
    mkdirSync(claudePath, { recursive: true, mode: 0o755 });
  }

  // Create hooks subdirectory
  const hooksPath = join(claudePath, HOOKS_DIR);
  if (!existsSync(hooksPath)) {
    mkdirSync(hooksPath, { recursive: true, mode: 0o755 });
  }

  // Install hook script
  const scriptName = 'sonar-prompt.sh';
  const scriptPath = join(hooksPath, scriptName);
  const scriptContent = getHookScriptContent(hookType);

  const fs = await import('fs/promises');
  await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });

  console.log(`   ✓ Installed hook script: ${scriptPath}`);

  // Configure hooks in settings.local.json
  await configureHooksSettings(claudePath, scriptName);

  console.log('   ✓ Hooks configured');
}

/**
 * Get hook script content based on type
 */
function getHookScriptContent(hookType: HookType): string {
  if (hookType === 'cli') {
    return getHookCLITemplate();
  }
  return getHookPromptTemplate();
}

/**
 * Configure hooks in settings.local.json
 */
async function configureHooksSettings(
  claudePath: string,
  scriptName: string
): Promise<void> {
  const settingsPath = join(claudePath, SETTINGS_FILE);

  let settings: ClaudeSettings;

  // Load existing settings or create new
  if (existsSync(settingsPath)) {
    const fs = await import('fs/promises');
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
  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Add PostToolUse hook
  settings.hooks.PostToolUse = [
    {
      matcher: 'Edit|Write',
      hooks: [
        {
          type: 'command',
          command: `.claude/hooks/${scriptName}`,
          timeout: 120
        }
      ]
    }
  ];

  // Ensure permissions section exists and add MCP tool permission
  if (!settings.permissions) {
    settings.permissions = { allow: [] };
  }
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }

  // Add MCP tool permission if not already present
  const mcpToolPermission = 'mcp__sonarqube__analyze_code_snippet';
  if (!settings.permissions.allow.includes(mcpToolPermission)) {
    settings.permissions.allow.unshift(mcpToolPermission);
  }

  // Save settings
  const fs = await import('fs/promises');
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
    const fs = await import('fs/promises');
    const data = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(data);

    // Check if PostToolUse hook is actually configured
    return !!(settings.hooks?.PostToolUse && Array.isArray(settings.hooks.PostToolUse) && settings.hooks.PostToolUse.length > 0);
  } catch {
    return false;
  }
}

/**
 * Hook template for prompt-based analysis
 */
function getHookPromptTemplate(): string {
  return `#!/bin/bash
# SonarQube Analysis Hook for Claude Code
# This hook prompts the agent to analyze files after Edit/Write operations

set -e

# Read JSON from stdin
INPUT=$(cat)

# Extract tool name and file path from JSON
TOOL=$(echo "$INPUT" | jq -r '.tool_name')
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

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

# Detect language from extension
case "$FILE" in
    *.java) LANGUAGE="java" ;;
    *.js|*.jsx) LANGUAGE="javascript" ;;
    *.ts|*.tsx) LANGUAGE="typescript" ;;
    *.py) LANGUAGE="python" ;;
    *.go) LANGUAGE="go" ;;
    *.rb) LANGUAGE="ruby" ;;
    *.php) LANGUAGE="php" ;;
    *.cs) LANGUAGE="csharp" ;;
    *.cpp|*.c|*.h|*.hpp) LANGUAGE="cpp" ;;
esac

# Output prompt for the agent as JSON
# IMPORTANT: PostToolUse hooks MUST output JSON with hookSpecificOutput.additionalContext
# Plain text output is ignored by Claude Code!

# Build the prompt message
PROMPT="╔══════════════════════════════════════════════════════════╗
║        SONARQUBE ANALYSIS REQUIRED                       ║
╚══════════════════════════════════════════════════════════╝

You just modified: $FILE

You MUST analyze this file for code quality issues using MCP tool:
mcp__sonarqube__analyze_code_snippet with:
  - codeSnippet: <read file content from $FILE>
  - language: $LANGUAGE
  - projectKey: <get from sonar-project.properties if available>

You MUST fix ALL issues found in this file:
- Fix ALL bugs and security vulnerabilities (critical priority)
- Fix ALL code smells and maintainability issues
- Fix ALL issues even if they existed before your changes
- Fix ALL issues even if they are minor
- Do not skip any issues

The file must be completely clean before you proceed to the next task."

# Output as JSON
jq -n \\
  --arg prompt "$PROMPT" \\
  '{
    "hookSpecificOutput": {
      "hookEventName": "PostToolUse",
      "additionalContext": $prompt
    }
  }'

# Always exit 0 to never block Claude Code
exit 0
`;
}

/**
 * Hook template for CLI-based analysis
 */
function getHookCLITemplate(): string {
  return `#!/bin/bash
# SonarLint Hook - CLI Mode
# This hook automatically runs SonarLint analysis after code changes

# Read JSON from stdin
INPUT=$(cat)

# Extract tool name and file path from JSON using jq
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only analyze if Edit or Write was used
if [[ "$TOOL_NAME" != "Edit" && "$TOOL_NAME" != "Write" ]]; then
  exit 0
fi

# Check if file exists and is a supported language
if [ -f "$FILE_PATH" ]; then
  # Check file extension (only analyze code files)
  EXT="\${FILE_PATH##*.}"
  case "$EXT" in
    js|ts|jsx|tsx|java|py|go|rb|php|cs|cpp|c|h|hpp)
      echo ""
      echo "🔍 Analyzing $FILE_PATH with SonarLint..."
      sonar verify "$FILE_PATH"
      ;;
    *)
      # Skip non-code files
      ;;
  esac
fi
`;
}
