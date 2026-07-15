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

/**
 * Filesystem I/O for state.json — reading, writing, and in-place migration.
 * Business logic (addOrUpdateConnection, removeConnection, etc.) lives in state-manager.ts.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';

import { version as VERSION } from '../../../package.json';
import { CommandFailedError } from '../../cli/commands/_common/error.js';
import { getCliDir as resolveCliDir } from '../config-constants.js';
import logger from '../logger.js';
import { type CliState, getDefaultState } from '../state.js';

function getCliDir(): string {
  return resolveCliDir();
}

function getStateFile(): string {
  return join(getCliDir(), 'state.json');
}

function ensureStateDir(): void {
  if (!fs.existsSync(getCliDir())) {
    fs.mkdirSync(getCliDir(), { recursive: true });
  }
}

function migrateState(raw: Record<string, unknown>): CliState {
  if (!raw.telemetry) {
    raw.telemetry = {
      enabled: true,
      installationId: randomUUID(),
      firstUseDate: new Date().toISOString(),
    };
  }
  if (!raw.agentExtensions) {
    raw.agentExtensions = [];
  }
  if (!raw.integrations) {
    raw.integrations = { installed: [] };
  }
  if (!raw.dependencies) {
    raw.dependencies = { installed: [] };
  }
  if (!raw.auth) {
    raw.auth = getDefaultState(VERSION).auth;
    return raw as unknown as CliState;
  }
  // Strip legacy fields that older state files may still contain
  const connections = (raw.auth as Record<string, unknown>).connections;
  if (Array.isArray(connections)) {
    for (const conn of connections as Record<string, unknown>[]) {
      delete conn.keystoreKey;
    }
  }
  return raw as unknown as CliState;
}

export const STATE_READ_MAX_ATTEMPTS = 5;
const STATE_READ_RETRY_DELAY_MS = 100;

/**
 * Load state from file, or return default if not exists.
 * If an existing file fails to read, retry then throw, so saveState() can't wipe the state. CLI-834.
 */
export function loadState(cliVersion?: string): CliState {
  ensureStateDir();

  if (!fs.existsSync(getStateFile())) {
    return getDefaultState(cliVersion ?? VERSION);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < STATE_READ_MAX_ATTEMPTS; attempt++) {
    try {
      const content = fs.readFileSync(getStateFile(), 'utf-8');
      const raw = JSON.parse(content) as Record<string, unknown>;
      return migrateState(raw);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < STATE_READ_MAX_ATTEMPTS) {
        Bun.sleepSync(STATE_READ_RETRY_DELAY_MS);
      }
    }
  }

  logger.debug(`Failed to load state from ${getStateFile()}: ${(lastError as Error).message}`);
  throw new CommandFailedError(`Failed to read state: ${(lastError as Error).message}`, {
    cause: lastError,
    remediationHint: `The state file may be corrupted. Inspect or remove it at ${getStateFile()}, then try again.`,
  });
}

/** Best-effort variant of loadState() for paths that must never crash. */
export function tryLoadState(cliVersion?: string): CliState | null {
  try {
    return loadState(cliVersion);
  } catch (error) {
    logger.debug(`tryLoadState: ignoring state load failure: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Save state to file.
 */
export function saveState(state: CliState): void {
  ensureStateDir();

  state.lastUpdated = new Date().toISOString();

  try {
    fs.writeFileSync(getStateFile(), JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(`Failed to save state to ${getStateFile()}: ${String(error)}`);
  }
}

/**
 * Returns true when the state file exists on disk.
 * Respects the SONAR_USER_HOME override used in tests.
 */
export function stateFileExists(): boolean {
  return fs.existsSync(getStateFile());
}
