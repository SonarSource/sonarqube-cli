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
import logger from '../../../../lib/logger';
import {
  getSecretPreToolTemplateUnix,
  getSecretPreToolTemplateWindows,
  getSecretPromptTemplateUnix,
  getSecretPromptTemplateWindows,
  getA3sPostToolTemplateUnix,
  getA3sPostToolTemplateWindows,
} from './hook-templates';

const CLAUDE_DIR = '.claude';
const HOOKS_DIR = 'hooks';
const SETTINGS_FILE = 'settings.json';
const SONAR_SECRETS_MARKER = 'sonar-secrets';
const SONAR_A3S_MARKER = 'sonar-a3s';

interface HookConfig {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout: number;
  }>;
}

interface ClaudeSettings {
  hooks?: Record<string, HookConfig[] | undefined>;
  [key: string]: unknown;
}

/**
 * Returns true if a hook config entry belongs to sonar-secrets
 */
function isSonarSecretsEntry(entry: HookConfig): boolean {
  return (
    Array.isArray(entry.hooks) && entry.hooks.some((h) => h.command.includes(SONAR_SECRETS_MARKER))
  );
}

/**
 * Returns true if a hook config entry belongs to sonar-a3s
 */
function isSonarA3sEntry(entry: HookConfig): boolean {
  return (
    Array.isArray(entry.hooks) && entry.hooks.some((h) => h.command.includes(SONAR_A3S_MARKER))
  );
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
 * Check if hooks are installed.
 * The hooksRoot parameter is the directory whose .claude/settings.json file is inspected.
 */
export async function areHooksInstalled(hooksRoot: string): Promise<boolean> {
  const settingsPath = join(hooksRoot, CLAUDE_DIR, SETTINGS_FILE);

  if (!existsSync(settingsPath)) {
    return false;
  }

  try {
    const fs = await import('node:fs/promises');
    const data = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(data) as ClaudeSettings;

    // Check if a sonar-secrets PreToolUse hook is configured
    return Boolean(
      settings.hooks?.PreToolUse &&
      Array.isArray(settings.hooks.PreToolUse) &&
      settings.hooks.PreToolUse.some(isSonarSecretsEntry),
    );
  } catch {
    return false;
  }
}

type FsWriter = {
  writeFile: (path: string, data: string, options?: { mode?: number }) => Promise<void>;
};

/**
 * Generate secret scanning hooks dynamically
 */
async function generateSecretHooks(
  fs: FsWriter,
  isWindows: boolean,
  scriptExt: string,
  targetScriptsDir: string,
): Promise<void> {
  const preTool = isWindows ? getSecretPreToolTemplateWindows() : getSecretPreToolTemplateUnix();
  const prompt = isWindows ? getSecretPromptTemplateWindows() : getSecretPromptTemplateUnix();

  const preToolPath = join(targetScriptsDir, `pretool-secrets${scriptExt}`);
  const promptPath = join(targetScriptsDir, `prompt-secrets${scriptExt}`);

  if (isWindows) {
    await fs.writeFile(preToolPath, preTool);
    await fs.writeFile(promptPath, prompt);
  } else {
    await fs.writeFile(preToolPath, preTool, { mode: 0o755 });
    await fs.writeFile(promptPath, prompt, { mode: 0o755 });
  }
}

/**
 * Generate A3S PostToolUse hook script
 */
async function generateA3sHook(
  fs: FsWriter,
  isWindows: boolean,
  scriptExt: string,
  targetScriptsDir: string,
): Promise<void> {
  const postTool = isWindows ? getA3sPostToolTemplateWindows() : getA3sPostToolTemplateUnix();
  const postToolPath = join(targetScriptsDir, `posttool-a3s${scriptExt}`);

  if (isWindows) {
    await fs.writeFile(postToolPath, postTool);
  } else {
    await fs.writeFile(postToolPath, postTool, { mode: 0o755 });
  }
}

/**
 * Install sonar-secrets hooks (cross-platform).
 * When globalDir is provided, installs to globalDir/.claude/ with absolute command paths.
 * When globalDir is undefined (default), installs to projectRoot/.claude/ with relative paths.
 */
export async function installSecretScanningHooks(
  projectRoot: string,
  globalDir?: string,
): Promise<void> {
  try {
    const fs = await import('node:fs/promises');
    const isGlobal = globalDir !== undefined;
    const baseDir = isGlobal ? globalDir : projectRoot;
    const claudePath = join(baseDir, CLAUDE_DIR);
    const hooksPath = join(claudePath, HOOKS_DIR);

    // Create hooks directory
    mkdirSync(hooksPath, { recursive: true });

    const secretsScriptsDir = join(hooksPath, 'sonar-secrets', 'build-scripts');
    const a3sScriptsDir = join(hooksPath, 'sonar-a3s', 'build-scripts');

    mkdirSync(secretsScriptsDir, { recursive: true });
    mkdirSync(a3sScriptsDir, { recursive: true });

    const isWindows = getPlatform() === 'windows';
    const scriptExt = getScriptExtension();

    await generateSecretHooks(fs, isWindows, scriptExt, secretsScriptsDir);
    await generateA3sHook(fs, isWindows, scriptExt, a3sScriptsDir);

    // Register hooks in settings.json
    const settingsPath = join(claudePath, SETTINGS_FILE);
    let settings: ClaudeSettings = { hooks: {} };

    if (existsSync(settingsPath)) {
      const data = await fs.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(data) as ClaudeSettings;
    }

    // Ensure hooks section exists
    settings.hooks ??= {};

    // Global hooks use absolute paths; project hooks use paths relative to project root
    const secretsRelativeDir = join(CLAUDE_DIR, HOOKS_DIR, 'sonar-secrets', 'build-scripts');
    const a3sRelativeDir = join(CLAUDE_DIR, HOOKS_DIR, 'sonar-a3s', 'build-scripts');
    const secretsDir = isGlobal ? join(baseDir, secretsRelativeDir) : secretsRelativeDir;
    const a3sDir = isGlobal ? join(baseDir, a3sRelativeDir) : a3sRelativeDir;

    const preToolScript = join(secretsDir, `pretool-secrets${scriptExt}`);
    const promptScript = join(secretsDir, `prompt-secrets${scriptExt}`);
    const postToolScript = join(a3sDir, `posttool-a3s${scriptExt}`);

    const makeCommand = (script: string) =>
      isWindows ? `powershell -NoProfile -File ${script.replaceAll('\\', '/')}` : script;

    // Merge secrets hooks — replace any prior sonar-secrets entry
    settings.hooks.PreToolUse = [
      ...(settings.hooks.PreToolUse ?? []).filter((e) => !isSonarSecretsEntry(e)),
      {
        matcher: 'Read',
        hooks: [{ type: 'command', command: makeCommand(preToolScript), timeout: 60 }],
      },
    ];

    settings.hooks.UserPromptSubmit = [
      ...(settings.hooks.UserPromptSubmit ?? []).filter((e) => !isSonarSecretsEntry(e)),
      {
        matcher: '*',
        hooks: [{ type: 'command', command: makeCommand(promptScript), timeout: 60 }],
      },
    ];

    // Merge A3S PostToolUse hook — replace any prior sonar-a3s entry
    settings.hooks.PostToolUse = [
      ...(settings.hooks.PostToolUse ?? []).filter((e) => !isSonarA3sEntry(e)),
      {
        matcher: 'Edit|Write',
        hooks: [{ type: 'command', command: makeCommand(postToolScript), timeout: 60 }],
      },
    ];

    // Save updated settings
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    logger.debug(`Failed to install secret scanning hooks: ${(error as Error).message}`);
    // Non-critical - don't fail if hooks installation fails
  }
}
