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

import { isAbsolute, resolve } from 'node:path';

import { getBooleanConfigValue, getConfigValue } from '@/core/config/config-repository.ts';
import type { ConfigKey } from '@/core/config/config-schema.ts';
import { MAX_SCANNED_FILE_SIZE } from '@/core/config-constants.ts';
import { resolveGitRepoRoot } from '@/core/host/git/worktree.ts';
import logger from '@/core/observability/logger.ts';

/** The sonar-secrets analysis settings read from the `secrets.*` config keys. */
export interface SecretsScanSettings {
  /** Bytes; 0 means no limit. */
  maxFileSize: number;
  /** Absolute paths. */
  exclusions: string[];
  disableTestFileDetection: boolean;
  disableEntropyFilter: boolean;
  disableKnownFakeSecretFilter: boolean;
  demoMode: boolean;
}

export const DEFAULT_SECRETS_SCAN_SETTINGS: SecretsScanSettings = {
  maxFileSize: MAX_SCANNED_FILE_SIZE,
  exclusions: [],
  disableTestFileDetection: false,
  disableEntropyFilter: false,
  disableKnownFakeSecretFilter: false,
  demoMode: false,
};

export async function loadSecretsScanSettings(
  cwd: string = process.cwd(),
): Promise<SecretsScanSettings> {
  const [maxFileSize, exclude] = await Promise.all([
    fromStored('secrets.maxFileSize'),
    fromStored('secrets.exclude'),
  ]);
  return {
    maxFileSize: parseMaxFileSize(maxFileSize),
    exclusions: await resolveConfiguredExclusions(exclude, cwd),
    disableTestFileDetection: fromStoredBoolean('secrets.disableTestFileDetection'),
    disableEntropyFilter: fromStoredBoolean('secrets.disableEntropyFilter'),
    disableKnownFakeSecretFilter: fromStoredBoolean('secrets.disableKnownFakeSecretFilter'),
    demoMode: fromStoredBoolean('secrets.demoMode'),
  };
}

// Stored settings are optional, so an unreadable store must not stop a scan; unset falls back to the defaults,
// which scan the most.
async function fromStored(key: ConfigKey): Promise<string | undefined> {
  try {
    return await getConfigValue(key);
  } catch (err) {
    logIgnoredConfig(key, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

function fromStoredBoolean(key: ConfigKey): boolean {
  try {
    return getBooleanConfigValue(key, false);
  } catch (err) {
    logIgnoredConfig(key, err instanceof Error ? err.message : String(err));
    return false;
  }
}

function logIgnoredConfig(key: ConfigKey, reason: string): void {
  logger.debug(`Ignoring stored config '${key}': ${reason}`);
}

function parseMaxFileSize(raw: string | undefined): number {
  if (raw === undefined) return MAX_SCANNED_FILE_SIZE;
  if (!/^\d+$/.test(raw)) {
    logIgnoredConfig('secrets.maxFileSize', `'${raw}' is not a non-negative integer`);
    return MAX_SCANNED_FILE_SIZE;
  }
  return Number(raw);
}

/** The config is shared by every repository, so a relative entry means a path inside the one being scanned. */
async function resolveConfiguredExclusions(
  raw: string | undefined,
  cwd: string,
): Promise<string[]> {
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.every((entry) => isAbsolute(entry))) return entries;

  const base = (await resolveGitRepoRoot(cwd)) ?? cwd;
  return entries.map((entry) => resolve(base, entry));
}
