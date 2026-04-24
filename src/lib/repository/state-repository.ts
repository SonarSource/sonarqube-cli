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
 * Business logic (addOrUpdateConnection, upsertAgentExtension, etc.) lives in state-manager.ts.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';

import { version as VERSION } from '../../../package.json';
import { CLI_DIR } from '../config-constants.js';
import logger from '../logger.js';
import { type CliState, getDefaultState } from '../state.js';

function getCliDir(): string {
  return process.env.SONARQUBE_CLI_DIR ?? CLI_DIR;
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
      events: [],
    };
  }
  if (!raw.agentExtensions) {
    raw.agentExtensions = [];
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

/**
 * Load state from file, or return default if not exists.
 */
export function loadState(cliVersion?: string): CliState {
  ensureStateDir();

  if (!fs.existsSync(getStateFile())) {
    return getDefaultState(cliVersion ?? VERSION);
  }

  try {
    const content = fs.readFileSync(getStateFile(), 'utf-8');
    const raw = JSON.parse(content) as Record<string, unknown>;
    return migrateState(raw);
  } catch (error) {
    logger.debug(`Failed to load state from ${getStateFile()}: ${(error as Error).message}`);
    return getDefaultState(cliVersion ?? VERSION);
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
 * Respects the SONARQUBE_CLI_DIR override used in tests.
 */
export function stateFileExists(): boolean {
  return fs.existsSync(getStateFile());
}
