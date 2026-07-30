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

// Legacy Claude Code hook migration, consumed by the post-update mechanism
// that runs automatically after CLI upgrades. Also holds the sonar-a3s
// obsolete-artifact cleanup helpers, which are Claude-specific but called
// directly (not just from migrateClaudeCodeHooks below) by
// commands/integrate/claude/index.ts (manual re-run) and post-update.ts's
// own top-level state cleanup.

import * as fs from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import logger from '../observability/logger.ts';
import type { CliState, HookExtension } from '../state/state.ts';
import { loadState } from '../state/state-repository.ts';

/**
 * Signature of `@/commands/integrate/claude/hooks.ts`'s `installHooks`,
 * injected by the CLI composition root so this module (which lives in
 * `core/` and must not depend on `commands/`) doesn't need to import it.
 */
export type InstallHooksFn = (
  projectRoot: string,
  globalDir: string | undefined,
  installSqaa: boolean,
) => Promise<void>;

/**
 * Migrate Claude Code hook scripts and reinstall secrets hooks for all known locations.
 *
 * Location discovery strategy:
 * 1. If agentExtensions registry has claude-code entries → use those (new format).
 * 2. Fallback for pre-registry installs: if agent is configured but registry is empty,
 *    check whether global hooks exist in homedir()/.claude and migrate there.
 *    Project-level hooks without registry entries cannot be discovered — user must
 *    re-run `sonar integrate claude` once to populate the registry.
 *
 * installSqaa is always false here: SQAA entitlement check requires a token which
 * is not available during post-update. User re-runs `sonar integrate claude` to
 * get the SQAA hook installed.
 *
 * @param homedirFn - Injectable for tests; defaults to os.homedir()
 */
export async function migrateClaudeCodeHooks(
  installHooksFn: InstallHooksFn,
  claudeIntegrationId: string,
  homedirFn: () => string = homedir,
): Promise<void> {
  const state = loadState();

  if (hasInstalledDeclarativeIntegration(state, claudeIntegrationId)) {
    logger.debug('Declarative Claude Code integration detected — skipping legacy hook migration');
    return;
  }

  const locations = resolveLocations(state, homedirFn);

  for (const { projectRoot, globalDir } of locations) {
    try {
      migrateHookScripts(projectRoot, globalDir);
      await installHooksFn(projectRoot, globalDir, false);
      await removeObsoleteHookArtifacts(projectRoot);
      logger.debug(`Migrated Claude Code hooks for: ${globalDir ?? projectRoot}`);
    } catch (err) {
      logger.debug(
        `Hook migration failed for ${globalDir ?? projectRoot}: ${(err as Error).message}`,
      );
    }
  }
}

type Location = { projectRoot: string; globalDir: string | undefined };

function resolveLocations(state: CliState, homedirFn: () => string): Location[] {
  const extensions = state.agentExtensions.filter(
    (e): e is HookExtension => e.agentId === 'claude-code' && e.kind === 'hook',
  );

  if (extensions.length > 0) {
    // New format: use registry entries, deduplicate by (projectRoot, globalDir)
    const locations: Location[] = [];
    const seen = new Set<string>();
    for (const ext of extensions) {
      const globalDir = ext.global ? homedirFn() : undefined;
      const key = `${ext.projectRoot}|${globalDir ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push({ projectRoot: ext.projectRoot, globalDir });
    }
    return locations;
  }

  if (state.agents['claude-code'].configured) {
    // Pre-registry fallback: check for global hooks in homedir
    const globalHooksDir = join(homedirFn(), '.claude', 'hooks', 'sonar-secrets');
    if (fs.existsSync(globalHooksDir)) {
      return [{ projectRoot: homedirFn(), globalDir: homedirFn() }];
    }
  }

  return [];
}

function hasInstalledDeclarativeIntegration(state: CliState, integrationId: string): boolean {
  return state.integrations.installed.some(
    (entry) => entry.integrationId === integrationId && entry.features.length > 0,
  );
}

// --- sonar-a3s obsolete artifact cleanup ---
// Shared by migrateClaudeCodeHooks above, commands/integrate/claude/index.ts
// (manual re-run), and post-update.ts (top-level state cleanup).

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
  state.agents['claude-code'].hooks.installed = state.agents['claude-code'].hooks.installed.filter(
    (h) => h.name !== OBSOLETE_A3S_MARKER,
  );
  state.agentExtensions = state.agentExtensions.filter((e) => e.name !== OBSOLETE_A3S_MARKER);
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
    if (!fs.existsSync(scriptPath)) {
      continue;
    }

    try {
      const content = fs.readFileSync(scriptPath, 'utf-8');
      // Replace old `sonar analyze --file` with `sonar analyze secrets`
      // Only replace if it's the direct analyze command, not already migrated
      const migrated = content.replaceAll('sonar analyze --file', 'sonar analyze secrets');

      if (migrated !== content) {
        fs.writeFileSync(scriptPath, migrated, 'utf-8');
        logger.debug(`Migrated hook script: ${script}`);
      }
    } catch (err) {
      logger.debug(`Failed to migrate script ${script}: ${(err as Error).message}`);
    }
  }
}
