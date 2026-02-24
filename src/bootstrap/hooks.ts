// Hooks installation - install Claude Code hooks (cross-platform)

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import logger from '../lib/logger.js';
import { success } from '../ui/index.js';
import {
  getHookPromptTemplateUnix,
  getHookCLITemplateUnix,
  getHookPromptTemplateWindows,
  getHookCLITemplateWindows,
  getSecretPreToolTemplateUnix,
  getSecretPreToolTemplateWindows,
  getSecretPromptTemplateUnix,
  getSecretPromptTemplateWindows
} from './hook-templates.js';

const CLAUDE_DIR = '.claude';
const HOOKS_DIR = 'hooks';
const SETTINGS_FILE = 'settings.json';

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

  success(`Installed hook script: ${scriptPath}`);

  // Configure hooks in settings.json
  await configureHooksSettings(claudePath, scriptName);

  success('Hooks configured');
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
 * Configure hooks in settings.json (cross-platform paths)
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
 * Generate secret scanning hooks dynamically
 */
async function generateSecretHooks(
  fs: { writeFile: Function },
  isWindows: boolean,
  scriptExt: string,
  targetScriptsDir: string
): Promise<void> {
  const preTool = isWindows ? getSecretPreToolTemplateWindows() : getSecretPreToolTemplateUnix();
  const prompt = isWindows ? getSecretPromptTemplateWindows() : getSecretPromptTemplateUnix();

  const preToolPath = join(targetScriptsDir, `pretool-secrets${scriptExt}`);
  const promptPath = join(targetScriptsDir, `prompt-secrets${scriptExt}`);

  if (isWindows) {
    // Windows: no special permissions
    await fs.writeFile(preToolPath, preTool);
    await fs.writeFile(promptPath, prompt);
  } else {
    // Unix: set executable permissions
    await fs.writeFile(preToolPath, preTool, { mode: 0o755 });
    await fs.writeFile(promptPath, prompt, { mode: 0o755 });
  }
}

/**
 * Install sonar-secrets hooks to project (cross-platform)
 * Creates hook build-scripts dynamically and registers them in .claude/settings.json
 */
export async function installSecretScanningHooks(projectRoot: string): Promise<void> {
  try {
    const fs = await import('node:fs/promises');
    const claudePath = join(projectRoot, CLAUDE_DIR);
    const hooksPath = join(claudePath, HOOKS_DIR);

    // Create hooks directory
    mkdirSync(hooksPath, { recursive: true });

    const targetScriptsDir = join(hooksPath, 'sonar-secrets', 'build-scripts');

    mkdirSync(targetScriptsDir, { recursive: true });

    const isWindows = getPlatform() === 'windows';
    const scriptExt = getScriptExtension();

    await generateSecretHooks(fs, isWindows, scriptExt, targetScriptsDir);

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
            command: join('.claude', 'hooks', 'sonar-secrets', 'build-scripts', `pretool-secrets${scriptExt}`),
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
            command: join('.claude', 'hooks', 'sonar-secrets', 'build-scripts', `prompt-secrets${scriptExt}`),
            timeout: 60
          }
        ]
      }
    ];

    // Save updated settings
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    logger.debug(`Failed to install secret scanning hooks: ${(error as Error).message}`);
    // Non-critical - don't fail if hooks installation fails
  }
}

