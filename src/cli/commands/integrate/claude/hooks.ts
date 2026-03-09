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

type FsWriter = {
  writeFile: (path: string, data: string, options?: { mode?: number }) => Promise<void>;
};

function getPlatform(): 'windows' | 'unix' {
  return platform() === 'win32' ? 'windows' : 'unix';
}

function getScriptExtension(): string {
  return getPlatform() === 'windows' ? '.ps1' : '.sh';
}

/**
 * Write a script file with executable permissions on Unix.
 */
async function writeScript(
  fs: FsWriter,
  scriptPath: string,
  content: string,
  isWindows: boolean,
): Promise<void> {
  await fs.writeFile(scriptPath, content, isWindows ? undefined : { mode: 0o755 });
}

/**
 * Upsert a hook entry in settings.json, replacing any existing entry owned by the same marker.
 */
function upsertHookEntry(
  settings: ClaudeSettings,
  eventType: string,
  marker: string,
  matcher: string,
  command: string,
  timeout: number,
): void {
  const isOwned = (e: HookConfig) =>
    Array.isArray(e.hooks) && e.hooks.some((h) => h.command.includes(marker));
  settings.hooks![eventType] = [
    ...(settings.hooks![eventType] ?? []).filter((e) => !isOwned(e)),
    { matcher, hooks: [{ type: 'command', command, timeout }] },
  ];
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
      settings.hooks.PreToolUse.some(
        (e) =>
          Array.isArray(e.hooks) && e.hooks.some((h) => h.command.includes(SONAR_SECRETS_MARKER)),
      ),
    );
  } catch {
    return false;
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
    const isWindows = getPlatform() === 'windows';
    const scriptExt = getScriptExtension();

    // Create script directories and write scripts
    const secretsScriptsDir = join(hooksPath, 'sonar-secrets', 'build-scripts');
    const a3sScriptsDir = join(hooksPath, 'sonar-a3s', 'build-scripts');
    mkdirSync(secretsScriptsDir, { recursive: true });
    mkdirSync(a3sScriptsDir, { recursive: true });

    await writeScript(
      fs,
      join(secretsScriptsDir, `pretool-secrets${scriptExt}`),
      isWindows ? getSecretPreToolTemplateWindows() : getSecretPreToolTemplateUnix(),
      isWindows,
    );
    await writeScript(
      fs,
      join(secretsScriptsDir, `prompt-secrets${scriptExt}`),
      isWindows ? getSecretPromptTemplateWindows() : getSecretPromptTemplateUnix(),
      isWindows,
    );
    await writeScript(
      fs,
      join(a3sScriptsDir, `posttool-a3s${scriptExt}`),
      isWindows ? getA3sPostToolTemplateWindows() : getA3sPostToolTemplateUnix(),
      isWindows,
    );

    // Load or initialise settings.json
    const settingsPath = join(claudePath, SETTINGS_FILE);
    let settings: ClaudeSettings = { hooks: {} };
    if (existsSync(settingsPath)) {
      const data = await fs.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(data) as ClaudeSettings;
    }
    settings.hooks ??= {};

    // Resolve command paths (absolute for global, relative for project)
    const secretsRelativeDir = join(CLAUDE_DIR, HOOKS_DIR, 'sonar-secrets', 'build-scripts');
    const a3sRelativeDir = join(CLAUDE_DIR, HOOKS_DIR, 'sonar-a3s', 'build-scripts');
    const secretsDir = isGlobal ? join(baseDir, secretsRelativeDir) : secretsRelativeDir;
    const a3sDir = isGlobal ? join(baseDir, a3sRelativeDir) : a3sRelativeDir;

    const cmd = (script: string) =>
      isWindows ? `powershell -NoProfile -File ${script.replaceAll('\\', '/')}` : script;

    // Register hooks — each call replaces the prior entry for that marker
    upsertHookEntry(
      settings,
      'PreToolUse',
      SONAR_SECRETS_MARKER,
      'Read',
      cmd(join(secretsDir, `pretool-secrets${scriptExt}`)),
      60,
    );
    upsertHookEntry(
      settings,
      'UserPromptSubmit',
      SONAR_SECRETS_MARKER,
      '*',
      cmd(join(secretsDir, `prompt-secrets${scriptExt}`)),
      60,
    );
    upsertHookEntry(
      settings,
      'PostToolUse',
      SONAR_A3S_MARKER,
      'Edit|Write',
      cmd(join(a3sDir, `posttool-a3s${scriptExt}`)),
      60,
    );

    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (error) {
    logger.debug(`Failed to install secret scanning hooks: ${(error as Error).message}`);
    // Non-critical - don't fail if hooks installation fails
  }
}
