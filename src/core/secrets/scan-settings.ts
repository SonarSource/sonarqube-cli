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

import { getConfigValue, getKeyDefinition } from '@/core/config/config-repository.ts';
import {
  type ConfigKey,
  describeAcceptedValues,
  isValidConfigValue,
} from '@/core/config/config-schema.ts';
import { MAX_SCANNED_FILE_SIZE } from '@/core/config-constants.ts';
import { resolveGitRepoRoot } from '@/core/host/git/worktree.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
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
  const [
    maxFileSize,
    exclude,
    disableTestFileDetection,
    disableEntropyFilter,
    disableKnownFakeSecretFilter,
    demoMode,
  ] = await Promise.all([
    fromStored('secrets.maxFileSize'),
    fromStored('secrets.exclude'),
    fromStored('secrets.disableTestFileDetection'),
    fromStored('secrets.disableEntropyFilter'),
    fromStored('secrets.disableKnownFakeSecretFilter'),
    fromStored('secrets.demoMode'),
  ]);
  const defaults = DEFAULT_SECRETS_SCAN_SETTINGS;
  return {
    maxFileSize: maxFileSize === undefined ? defaults.maxFileSize : Number(maxFileSize),
    exclusions:
      exclude === undefined ? defaults.exclusions : await resolveConfiguredExclusions(exclude, cwd),
    disableTestFileDetection: toBoolean(
      disableTestFileDetection,
      defaults.disableTestFileDetection,
    ),
    disableEntropyFilter: toBoolean(disableEntropyFilter, defaults.disableEntropyFilter),
    disableKnownFakeSecretFilter: toBoolean(
      disableKnownFakeSecretFilter,
      defaults.disableKnownFakeSecretFilter,
    ),
    demoMode: toBoolean(demoMode, defaults.demoMode),
  };
}

function toBoolean(raw: string | undefined, fallback: boolean): boolean {
  return raw === undefined ? fallback : raw === 'true';
}

/** An unreadable value, or one `config set` would reject, counts as unset. */
async function fromStored(key: ConfigKey): Promise<string | undefined> {
  let raw: string | undefined;
  try {
    raw = await getConfigValue(key);
  } catch (err) {
    logIgnoredConfig(key, err instanceof Error ? err.message : String(err));
    return undefined;
  }
  if (raw === undefined) return undefined;

  const definition = getKeyDefinition(key);
  if (!isValidConfigValue(definition, raw)) {
    logIgnoredConfig(key, `'${raw}' is invalid. ${describeAcceptedValues(definition)}`);
    return undefined;
  }
  return raw;
}

function logIgnoredConfig(key: ConfigKey, reason: string): void {
  logger.debug(`Ignoring stored config '${key}': ${reason}`);
}

/** The config is shared by every repository, so a relative entry means a path inside the one being scanned. */
async function resolveConfiguredExclusions(raw: string, cwd: string): Promise<string[]> {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const base = entries.every((entry) => isAbsolute(entry))
    ? cwd
    : ((await resolveGitRepoRoot(cwd)) ?? cwd);
  // sonar-secrets only matches canonical paths, so an entry through a symlink would never match.
  return entries.map((entry) => canonicalizePath(resolve(base, entry)));
}
