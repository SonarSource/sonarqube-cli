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

import { Database } from 'bun:sqlite';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import logger from '@/core/observability/logger.ts';

import { version as VERSION } from '../../../package.json';
import { getCliDir as resolveCliDir } from '../config-constants.ts';
import {
  type CliState,
  getDefaultState,
  type InstalledIntegrationDependency,
  type InstalledTool,
} from './state.ts';
import { mergeStateValue } from './state-merge.ts';

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
  migrateLegacyToolRecords(raw);
  backfillInstalledFeatureArrays(raw);
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
 * `InstalledIntegrationFeature` declares `dependencies`, `resources` and `operations` as
 * required, but a state file written by an older CLI can omit them, and the load path casts
 * rather than validates — so readers would trust a type that lies and throw on `.find()`.
 */
function backfillInstalledFeatureArrays(raw: Record<string, unknown>): void {
  const installed = (raw.integrations as { installed?: unknown }).installed;
  if (!Array.isArray(installed)) {
    return;
  }

  for (const integration of installed as Record<string, unknown>[]) {
    if (!Array.isArray(integration.features)) {
      integration.features = [];
      continue;
    }
    for (const feature of integration.features as Record<string, unknown>[]) {
      backfillFeatureArrays(feature);
    }
  }
}

function backfillFeatureArrays(feature: Record<string, unknown>): void {
  for (const field of ['dependencies', 'resources', 'operations']) {
    if (!Array.isArray(feature[field])) {
      feature[field] = [];
    }
  }
}

/**
 * Fold the legacy `tools.installed` registry into `dependencies.installed`, which is
 * the only one still read, and drop the field for good.
 */
function migrateLegacyToolRecords(raw: Record<string, unknown>): void {
  const legacy = (raw.tools as { installed?: unknown } | undefined)?.installed;
  delete raw.tools;
  if (!Array.isArray(legacy) || legacy.length === 0) {
    return;
  }

  const dependencies = (raw.dependencies as { installed: InstalledIntegrationDependency[] })
    .installed;
  const knownIds = new Set(dependencies.map((entry) => entry.id));

  for (const tool of legacy as InstalledTool[]) {
    if (knownIds.has(tool.name) || !fs.existsSync(tool.path)) {
      continue;
    }
    dependencies.push({
      id: tool.name,
      version: tool.version,
      path: tool.path,
      updatedAt: tool.installedAt,
      updatedByCliVersion: tool.installedByCliVersion,
    });
    knownIds.add(tool.name);
  }
}

export const STATE_READ_MAX_ATTEMPTS = 5;
const STATE_READ_RETRY_DELAY_MS = 100;

let cachedReadFailure: { fingerprint: string; error: CommandFailedError } | null = null;
const stateBaselines = new WeakMap<CliState, CliState>();
const STATE_LOCK_WAIT_MS = 10_000;
const STATE_FILE_MODE = 0o600;

function rememberBaseline(state: CliState): CliState {
  stateBaselines.set(state, structuredClone(state));
  return state;
}

function withStateLock<T>(action: () => T): T {
  const db = new Database(`${getStateFile()}.lock.sqlite`, { create: true });
  try {
    db.run(`PRAGMA busy_timeout = ${STATE_LOCK_WAIT_MS}`);
    return db.transaction(action).immediate();
  } finally {
    db.close();
  }
}

function replaceStateFile(state: CliState): void {
  const tempFile = `${getStateFile()}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tempFile, 'wx', STATE_FILE_MODE);
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2), 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempFile, getStateFile());
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
}

function stateFileFingerprint(): string | null {
  try {
    const stats = fs.statSync(getStateFile());
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return null;
  }
}

/**
 * Load state from file, or return default if not exists.
 * If an existing file fails to read, retry then throw, so saveState() can't wipe the state. CLI-834.
 */
export function loadState(cliVersion?: string): CliState {
  ensureStateDir();

  if (!fs.existsSync(getStateFile())) {
    return rememberBaseline(getDefaultState(cliVersion ?? VERSION));
  }

  if (cachedReadFailure !== null && cachedReadFailure.fingerprint === stateFileFingerprint()) {
    throw cachedReadFailure.error;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < STATE_READ_MAX_ATTEMPTS; attempt++) {
    try {
      const content = fs.readFileSync(getStateFile(), 'utf-8');
      const raw = JSON.parse(content) as Record<string, unknown>;
      cachedReadFailure = null;
      return rememberBaseline(migrateState(raw));
    } catch (error) {
      lastError = error;
      if (attempt + 1 < STATE_READ_MAX_ATTEMPTS) {
        Bun.sleepSync(STATE_READ_RETRY_DELAY_MS);
      }
    }
  }

  logger.error(`Failed to load state from ${getStateFile()}: ${(lastError as Error).message}`);
  const failure = new CommandFailedError(`Failed to read state: ${(lastError as Error).message}`, {
    cause: lastError,
    remediationHint: `The state file may be corrupted. Inspect or remove it at ${getStateFile()}, then try again.`,
  });
  const fingerprint = stateFileFingerprint();
  if (fingerprint !== null) {
    cachedReadFailure = { fingerprint, error: failure };
  }
  throw failure;
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
  try {
    withStateLock(() => {
      const existing = fs.existsSync(getStateFile());
      const baseline = stateBaselines.get(state);
      if (existing && baseline === undefined) {
        throw new Error('State was not loaded from the current state file');
      }
      const current = existing ? loadState() : undefined;
      const merged = (
        current && baseline ? mergeStateValue(baseline, state, current) : state
      ) as CliState;
      merged.lastUpdated = new Date().toISOString();
      replaceStateFile(merged);
      state.lastUpdated = merged.lastUpdated;
      rememberBaseline(state);
    });
  } catch (error) {
    throw new Error(`Failed to save state to ${getStateFile()}: ${String(error)}`);
  }
}

export function updateState<T>(update: (state: CliState) => T): T {
  ensureStateDir();
  try {
    return withStateLock(() => {
      const state = loadState();
      const result = update(state);
      state.lastUpdated = new Date().toISOString();
      replaceStateFile(state);
      return result;
    });
  } catch (error) {
    throw new Error(`Failed to update state in ${getStateFile()}: ${String(error)}`);
  }
}

/** Save state while preserving dependency updates written after the caller loaded its snapshot. */
export function saveStateKeepingInstalledDependencies(state: CliState): void {
  try {
    state.dependencies.installed = loadState().dependencies.installed;
  } catch (error) {
    logger.debug(
      `Keeping the in-memory dependency registry; re-read failed: ${(error as Error).message}`,
    );
  }
  saveState(state);
}

/**
 * Returns true when the state file exists on disk.
 * Respects the SONAR_USER_HOME override used in tests.
 */
export function stateFileExists(): boolean {
  return fs.existsSync(getStateFile());
}
