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

// Hooks installation - install Claude Code hooks (cross-platform)

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import logger from '../lib/logger.js';
import {
  getSecretPreToolTemplateUnix,
  getSecretPreToolTemplateWindows,
  getSecretPromptTemplateUnix,
  getSecretPromptTemplateWindows
} from './hook-templates.js';

const CLAUDE_DIR = '.claude';
const HOOKS_DIR = 'hooks';
const SETTINGS_FILE = 'settings.json';

interface HookConfig {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout: number;
  }>;
}

interface ClaudeSettings {
  hooks?: {
    [eventType: string]: HookConfig[];
  };
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

    // Check if PreToolUse hook is configured (secret scanning hooks)
    return !!(settings.hooks?.PreToolUse && Array.isArray(settings.hooks.PreToolUse) && settings.hooks.PreToolUse.length > 0);
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
