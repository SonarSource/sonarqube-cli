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

// Cleanup of the obsolete sonar-a3s Claude Code hook. Called by
// commands/integrate/claude/index.ts (manual re-run) and by post-update.ts's
// top-level state cleanup.

import * as fs from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import logger from '../observability/logger.ts';
import type { CliState } from '../state/state.ts';

const OBSOLETE_A3S_MARKER = 'sonar-a3s';
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
  if (!fs.existsSync(settingsPath)) {
    return undefined;
  }
  try {
    return JSON.parse(await readFile(settingsPath, 'utf-8')) as AgentSettings;
  } catch {
    return undefined;
  }
}

async function removeObsoleteSettingsEntries(installDir: string): Promise<void> {
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
      (e) =>
        !(Array.isArray(e.hooks) && e.hooks.some((h) => h.command.includes(OBSOLETE_A3S_MARKER))),
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

function deleteObsoleteHookDir(installDir: string): void {
  const obsoleteDir = join(installDir, CLAUDE_CONFIG_DIR, HOOKS_DIR, OBSOLETE_A3S_MARKER);
  if (fs.existsSync(obsoleteDir)) {
    fs.rmSync(obsoleteDir, { recursive: true, force: true });
  }
}

/**
 * Remove obsolete sonar-a3s hook entries from settings.json and delete the
 * obsolete hook script directory. Does NOT touch state.json — callers are
 * responsible for filtering state in-place.
 */
export async function removeObsoleteHookArtifacts(installDir: string): Promise<void> {
  try {
    await removeObsoleteSettingsEntries(installDir);
    deleteObsoleteHookDir(installDir);
  } catch (err) {
    logger.debug(
      `Failed to remove obsolete hook artifacts for ${OBSOLETE_A3S_MARKER}: ${(err as Error).message}`,
    );
  }
}

/**
 * Remove obsolete sonar-a3s hook entries from an in-memory state object.
 * Mutates state in place — caller is responsible for saving.
 */
export function cleanObsoleteFromState(state: CliState): void {
  const claude = (state as Partial<CliState>).agents?.['claude-code'];
  if (claude) {
    claude.hooks.installed = claude.hooks.installed.filter((h) => h.name !== OBSOLETE_A3S_MARKER);
  }
  state.agentExtensions = state.agentExtensions.filter((e) => e.name !== OBSOLETE_A3S_MARKER);
}
