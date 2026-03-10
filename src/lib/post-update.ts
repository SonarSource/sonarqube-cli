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

import fs from 'node:fs';
import { version as CURRENT_VERSION } from '../../package.json';
import { STATE_FILE } from './config-constants';
import logger from './logger';
import { loadState, saveState } from './state-manager';
import { isNewerVersion } from './version';

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
    saveState(state);
  } catch (error) {
    logger.debug(`Post-update actions failed: ${(error as Error).message}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function runActions(_previousVersion: string, _currentVersion: string): Promise<void> {
  // Add version-specific migration steps here as the CLI evolves.
}
