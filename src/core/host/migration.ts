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

// Cleanup helpers for obsolete Claude Code hook artifacts.
// Consumed by the post-update mechanism that runs automatically after CLI upgrades.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CliState } from '../../lib/state.ts';
import logger from '../observability/logger.ts';

export const OBSOLETE_A3S_MARKER = 'sonar-a3s';
const CLAUDE_CONFIG_DIR = '.claude';
const HOOKS_DIR = 'hooks';

interface HookEntry {
  command: string;
  [key: string]: unknown;
}
interface HookConfig {
  hooks: HookEntry[];
  [key: string]: unknown;
}
interface AgentSettings {
  hooks?: Record<string, HookConfig[] | undefined>;
  [key: string]: unknown;
}

async function readObsoleteSettings(settingsPath: string): Promise<AgentSettings | undefined> {
  if (!existsSync(settingsPath)) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(settingsPath, 'utf-8')) as AgentSettings;
  } catch {
    return undefined;
  }
}

async function removeObsoleteSettingsEntries(installDir: string, marker: string): Promise<void> {
  const settingsPath = join(installDir, CLAUDE_CONFIG_DIR, 'settings.json');
  const settings = await readObsoleteSettings(settingsPath);
  if (!settings?.hooks) {
    return;
  }
  let changed = false;
  for (const eventType of Object.keys(settings.hooks)) {
    const entries = settings.hooks[eventType];
    if (!Array.isArray(entries)) {
      continue;
    }
    const filtered = entries.filter(
      (e) => !(Array.isArray(e.hooks) && e.hooks.some((h) => h.command.includes(marker))),
    );
    if (filtered.length !== entries.length) {
      settings.hooks[eventType] = filtered;
      changed = true;
    }
  }
  if (changed) {
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }
}

function deleteObsoleteHookDir(installDir: string, marker: string): void {
  const obsoleteDir = join(installDir, CLAUDE_CONFIG_DIR, HOOKS_DIR, marker);
  if (existsSync(obsoleteDir)) {
    rmSync(obsoleteDir, { recursive: true, force: true });
  }
}

/**
 * Remove obsolete hook entries from the settings.json and delete the hook script directory.
 * Does NOT touch state.json — callers are responsible for filtering state in-place.
 */
export async function removeObsoleteHookArtifacts(
  installDir: string,
  marker: string,
): Promise<void> {
  try {
    await removeObsoleteSettingsEntries(installDir, marker);
    deleteObsoleteHookDir(installDir, marker);
  } catch (err) {
    logger.debug(
      `Failed to remove obsolete hook artifacts for ${marker}: ${(err as Error).message}`,
    );
  }
}

/**
 * Remove obsolete hook entries from an in-memory state object.
 * Mutates state in place — caller is responsible for saving.
 */
export function cleanObsoleteFromState(state: CliState, marker: string): void {
  state.agents['claude-code'].hooks.installed = state.agents['claude-code'].hooks.installed.filter(
    (h) => h.name !== marker,
  );
  state.agentExtensions = state.agentExtensions.filter((e) => e.name !== marker);
}

/**
 * Rewrite old hook scripts that called `sonar analyze --file` to use specific subcommands.
 * Also called from post-update.ts for automatic migration after CLI upgrades.
 */
export function migrateHookScripts(projectRoot: string, globalDir?: string): void {
  const baseDir = globalDir ?? projectRoot;
  const secretsDir = join(baseDir, '.claude', 'hooks', 'sonar-secrets', 'build-scripts');

  const scripts = [
    'pretool-secrets.sh',
    'prompt-secrets.sh',
    'pretool-secrets.ps1',
    'prompt-secrets.ps1',
  ];

  for (const script of scripts) {
    const scriptPath = join(secretsDir, script);
    if (!existsSync(scriptPath)) {
      continue;
    }

    try {
      const content = readFileSync(scriptPath, 'utf-8');
      // Replace old `sonar analyze --file` with `sonar analyze secrets`
      // Only replace if it's the direct analyze command, not already migrated
      const migrated = content.replaceAll('sonar analyze --file', 'sonar analyze secrets');

      if (migrated !== content) {
        writeFileSync(scriptPath, migrated, 'utf-8');
        logger.debug(`Migrated hook script: ${script}`);
      }
    } catch (err) {
      logger.debug(`Failed to migrate script ${script}: ${(err as Error).message}`);
    }
  }
}
