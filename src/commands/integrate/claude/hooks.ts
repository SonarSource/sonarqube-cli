/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
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

import * as fsPromises from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { IntegrationContext } from '@/core/framework/features';
import logger from '@/core/observability/logger.ts';

import {
  buildUnixHookScript,
  buildWindowsHookScript,
  readOrInitJson,
  resolveAgentHookCommand,
  writeHookScript,
} from '../_common/hooks.ts';

const HOOKS_DIR = 'hooks';
const SETTINGS_FILE = 'settings.json';

const AGENT_CONFIG_DIR: Record<string, string> = {
  claude: '.claude',
};

/**
 * Claude Code's environment variable for project root in case the agent changes cwd durign the run
 */
export const CLAUDE_PROJECT_DIR_PLACEHOLDER = '${CLAUDE_PROJECT_DIR}';

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

  const configDir = AGENT_CONFIG_DIR[agent];

  const fullScriptDir = join(installDir, configDir, HOOKS_DIR, dirname(scriptPath));
  await writeHookScript(
    fullScriptDir,
    basename(scriptPath),
    scriptContentUnix,
    scriptContentWindows,
  );

  const hookContext = { targetRoot: installDir, scope } as IntegrationContext;
  const command = resolveAgentHookCommand(
    hookContext,
    configDir,
    scriptPath,
    CLAUDE_PROJECT_DIR_PLACEHOLDER,
  );

  // Marker derived from first path segment (e.g. 'sonar-secrets' from 'sonar-secrets/build-scripts/pretool-secrets')
  const marker = scriptPath.split('/')[0];

  const settingsPath = join(installDir, configDir, SETTINGS_FILE);
  const settings = await readOrInitJson<AgentSettings>(settingsPath, { hooks: {} });
  settings.hooks ??= {};
  upsertHookEntry(settings, eventType, marker, matcher, command, timeout);
  await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Reinstall the secrets hooks (cross-platform) into globalDir when provided,
 * otherwise projectRoot. The Vortex analysis hook is deliberately not installed
 * here: it needs an entitlement check, which the post-update caller cannot do.
 */
export async function installHooks(projectRoot: string, globalDir?: string): Promise<void> {
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
      scriptContentUnix: buildUnixHookScript('claude-pre-tool-use'),
      scriptContentWindows: buildWindowsHookScript('claude-pre-tool-use'),
    });
    await installHook({
      installDir: secretsDir,
      scope: secretsScope,
      agent: 'claude',
      eventType: 'UserPromptSubmit',
      matcher: '*',
      scriptPath: 'sonar-secrets/build-scripts/prompt-secrets',
      scriptContentUnix: buildUnixHookScript('claude-prompt-submit'),
      scriptContentWindows: buildWindowsHookScript('claude-prompt-submit'),
    });
  } catch (error) {
    logger.debug(`Failed to install hooks: ${(error as Error).message}`);
    // Non-critical - don't fail if hooks installation fails
  }
}
