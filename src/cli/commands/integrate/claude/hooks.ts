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

// Hooks installation (cross-platform)

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
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

const HOOKS_DIR = 'hooks';
const SETTINGS_FILE = 'settings.json';
const SONAR_SECRETS_MARKER = 'sonar-secrets';

const AGENT_CONFIG_DIR: Record<string, string> = {
  claude: '.claude',
};

interface HookConfig {
  matcher: string;
  hooks: Array<{
    type: string;
    command: string;
    timeout: number;
  }>;
}

interface AgentSettings {
  hooks?: Record<string, HookConfig[] | undefined>;
  [key: string]: unknown;
}

interface HookInstallParams {
  installDir: string;
  /** 'global' uses absolute command path; 'project' uses path relative to installDir */
  scope: 'global' | 'project';
  agent: 'claude';
  eventType: string;
  matcher: string;
  /** Path within hooks dir, without extension: 'sonar-secrets/build-scripts/pretool-secrets' */
  scriptPath: string;
  scriptContentUnix: string;
  scriptContentWindows: string;
  timeout?: number;
}

function getPlatform(): 'windows' | 'unix' {
  return platform() === 'win32' ? 'windows' : 'unix';
}

function getScriptExtension(): string {
  return getPlatform() === 'windows' ? '.ps1' : '.sh';
}

function upsertHookEntry(
  settings: AgentSettings,
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

async function installHook(params: HookInstallParams): Promise<void> {
  const {
    installDir,
    scope,
    agent,
    eventType,
    matcher,
    scriptPath,
    scriptContentUnix,
    scriptContentWindows,
    timeout = 60,
  } = params;

  const isWindows = getPlatform() === 'windows';
  const scriptExt = getScriptExtension();
  const configDir = AGENT_CONFIG_DIR[agent];
  const fs = await import('node:fs/promises');

  // Write script file
  const fullScriptDir = join(installDir, configDir, HOOKS_DIR, dirname(scriptPath));
  mkdirSync(fullScriptDir, { recursive: true });
  const fullScriptPath = join(fullScriptDir, `${basename(scriptPath)}${scriptExt}`);
  await fs.writeFile(
    fullScriptPath,
    isWindows ? scriptContentWindows : scriptContentUnix,
    isWindows ? undefined : { mode: 0o755 },
  );

  // Global: absolute path; project: relative to installDir (portable when project is moved)
  const relativePath = join(configDir, HOOKS_DIR, `${scriptPath}${scriptExt}`);
  const commandPath = scope === 'global' ? fullScriptPath : relativePath;
  const command = isWindows
    ? `powershell -NoProfile -File ${commandPath.replaceAll('\\', '/')}`
    : commandPath;

  // Marker derived from first path segment (e.g. 'sonar-secrets' from 'sonar-secrets/build-scripts/pretool-secrets')
  const marker = scriptPath.split('/')[0];

  // Update settings.json
  const settingsPath = join(installDir, configDir, SETTINGS_FILE);
  let settings: AgentSettings = { hooks: {} };
  if (existsSync(settingsPath)) {
    const data = await fs.readFile(settingsPath, 'utf-8');
    settings = JSON.parse(data) as AgentSettings;
  }
  settings.hooks ??= {};
  upsertHookEntry(settings, eventType, marker, matcher, command, timeout);
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Check if hooks are installed.
 * The hooksRoot parameter is the directory whose agent config settings.json file is inspected.
 */
export async function areHooksInstalled(hooksRoot: string): Promise<boolean> {
  const settingsPath = join(hooksRoot, AGENT_CONFIG_DIR.claude, SETTINGS_FILE);

  if (!existsSync(settingsPath)) {
    return false;
  }

  try {
    const fs = await import('node:fs/promises');
    const data = await fs.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(data) as AgentSettings;

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
 * Install all hooks (cross-platform).
 * Secrets hooks install to globalDir (if provided), A3S hook installs to projectRoot.
 * A3S hook is only installed when installA3s is true (requires cloud connection + entitlement).
 */
export async function installHooks(
  projectRoot: string,
  globalDir?: string,
  installA3s = false,
): Promise<void> {
  const secretsDir = globalDir ?? projectRoot;
  const secretsScope = globalDir ? 'global' : 'project';

  try {
    await installHook({
      installDir: secretsDir,
      scope: secretsScope,
      agent: 'claude',
      eventType: 'PreToolUse',
      matcher: 'Read',
      scriptPath: 'sonar-secrets/build-scripts/pretool-secrets',
      scriptContentUnix: getSecretPreToolTemplateUnix(),
      scriptContentWindows: getSecretPreToolTemplateWindows(),
    });
    await installHook({
      installDir: secretsDir,
      scope: secretsScope,
      agent: 'claude',
      eventType: 'UserPromptSubmit',
      matcher: '*',
      scriptPath: 'sonar-secrets/build-scripts/prompt-secrets',
      scriptContentUnix: getSecretPromptTemplateUnix(),
      scriptContentWindows: getSecretPromptTemplateWindows(),
    });
    if (installA3s) {
      await installHook({
        installDir: projectRoot,
        scope: 'project',
        agent: 'claude',
        eventType: 'PostToolUse',
        matcher: 'Edit|Write',
        scriptPath: 'sonar-a3s/build-scripts/posttool-a3s',
        scriptContentUnix: getA3sPostToolTemplateUnix(),
        scriptContentWindows: getA3sPostToolTemplateWindows(),
      });
    }
  } catch (error) {
    logger.debug(`Failed to install hooks: ${(error as Error).message}`);
    // Non-critical - don't fail if hooks installation fails
  }
}
