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

import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { version as CURRENT_VERSION } from '../../package.json';
import { STATE_FILE } from './config-constants.js';
import logger from './logger';
import { loadState, saveState } from './state-manager';
import { isNewerVersion } from './version';
import {
  migrateHookScripts,
  cleanObsoleteFromState,
  removeObsoleteHookArtifacts,
  OBSOLETE_A3S_MARKER,
} from './migration.js';
import { installHooks } from '../cli/commands/integrate/claude/hooks.js';
import { SECRETS_BINARY_NAME } from './install-types.js';
import { installSecretsBinary } from '../cli/commands/_common/install/secrets';
import type { CliState } from './state.js';

/**
 * Runs any actions that need to happen once after the CLI has been updated.
 *
 * - Skipped entirely when the state file is absent (fresh installation).
 * - Skipped when the persisted CLI version matches or exceeds the current binary version.
 * - On success the persisted CLI version is bumped to `CURRENT_VERSION` so the
 *   actions are not repeated on the next invocation.
 */
export async function runPostUpdateActions(): Promise<void> {
  if (!fs.existsSync(STATE_FILE)) {
    // No state file means this is a fresh installation — nothing to migrate.
    return;
  }

  const state = loadState();
  const previousVersion = state.config.cliVersion;

  if (!isNewerVersion(previousVersion, CURRENT_VERSION)) {
    return;
  }

  logger.debug(`Running post-update actions (${previousVersion} → ${CURRENT_VERSION})`);

  try {
    await runActions(previousVersion, CURRENT_VERSION);
    state.config.cliVersion = CURRENT_VERSION;
    cleanObsoleteFromState(state, OBSOLETE_A3S_MARKER);
    saveState(state);
  } catch (error) {
    logger.debug(`Post-update actions failed: ${(error as Error).message}`);
  }
}

async function runActions(_previousVersion: string, _currentVersion: string): Promise<void> {
  await migrateClaudeCodeHooks();
  await updateSecretsBinaryIfNeeded();
}

/**
 * Update the sonar-secrets binary if it is already installed but targets a different version
 * than the one bundled with this CLI release.
 */
export async function updateSecretsBinaryIfNeeded(): Promise<void> {
  const state = loadState();

  if (!hasPreviousInstallation(state)) {
    logger.debug('sonar-secrets not installed — skipping binary update');
    return;
  }

  await installSecretsBinary();
}

function hasPreviousInstallation(state: CliState): boolean {
  return (state.tools?.installed ?? []).some((t) => t.name === SECRETS_BINARY_NAME);
}

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
export async function migrateClaudeCodeHooks(homedirFn: () => string = homedir): Promise<void> {
  const state = loadState();

  type Location = { projectRoot: string; globalDir: string | undefined };
  const locations: Location[] = [];

  const extensions = state.agentExtensions.filter((e) => e.agentId === 'claude-code');

  if (extensions.length > 0) {
    // New format: use registry entries, deduplicate by (projectRoot, globalDir)
    const seen = new Set<string>();
    for (const ext of extensions) {
      const globalDir = ext.global ? homedirFn() : undefined;
      const key = `${ext.projectRoot}|${globalDir ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push({ projectRoot: ext.projectRoot, globalDir });
    }
  } else if (state.agents['claude-code'].configured) {
    // Pre-registry fallback: check for global hooks in homedir
    const globalHooksDir = join(homedirFn(), '.claude', 'hooks', 'sonar-secrets');
    if (fs.existsSync(globalHooksDir)) {
      locations.push({ projectRoot: homedirFn(), globalDir: homedirFn() });
    }
  }

  for (const { projectRoot, globalDir } of locations) {
    try {
      migrateHookScripts(projectRoot, globalDir);
      await installHooks(projectRoot, globalDir, false);
      await removeObsoleteHookArtifacts(projectRoot, OBSOLETE_A3S_MARKER);
      logger.debug(`Migrated Claude Code hooks for: ${globalDir ?? projectRoot}`);
    } catch (err) {
      logger.debug(
        `Hook migration failed for ${globalDir ?? projectRoot}: ${(err as Error).message}`,
      );
    }
  }
}
