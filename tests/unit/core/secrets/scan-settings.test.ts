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

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import {
  CLI_CONFIG_FILE_NAME,
  ENV_SONAR_USER_HOME,
  MAX_SCANNED_FILE_SIZE,
} from '@/core/config-constants.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import logger from '@/core/observability/logger.ts';
import {
  DEFAULT_SECRETS_SCAN_SETTINGS,
  loadSecretsScanSettings,
} from '@/core/secrets/scan-settings.ts';

const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];
let testSonarUserHome: string;
let workDir: string;

function writeConfig(lines: string[]): void {
  const cliHome = join(testSonarUserHome, 'sonarqube-cli');
  mkdirSync(cliHome, { recursive: true });
  writeFileSync(join(cliHome, CLI_CONFIG_FILE_NAME), `${lines.join('\n')}\n`, 'utf-8');
}

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'secrets-scan-settings-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'secrets-scan-settings-work-'));
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;
});

afterEach(async () => {
  await rm(testSonarUserHome, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
  if (previousSonarUserHome === undefined) {
    delete process.env[ENV_SONAR_USER_HOME];
  } else {
    process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
  }
});

describe('loadSecretsScanSettings', () => {
  it('returns the defaults when no secrets key is configured', async () => {
    expect(await loadSecretsScanSettings(workDir)).toEqual(DEFAULT_SECRETS_SCAN_SETTINGS);
  });

  it('reads every secrets key from the config file', async () => {
    writeConfig([
      'secrets.maxFileSize=0',
      'secrets.disableTestFileDetection=true',
      'secrets.disableEntropyFilter=true',
      'secrets.disableKnownFakeSecretFilter=true',
      'secrets.demoMode=true',
    ]);

    expect(await loadSecretsScanSettings(workDir)).toEqual({
      maxFileSize: 0,
      exclusions: [],
      disableTestFileDetection: true,
      disableEntropyFilter: true,
      disableKnownFakeSecretFilter: true,
      demoMode: true,
    });
  });

  it('falls back to the default size limit for a hand-edited value that is not a number', async () => {
    writeConfig(['secrets.maxFileSize=2MB']);
    const debug = spyOn(logger, 'debug');

    try {
      expect((await loadSecretsScanSettings(workDir)).maxFileSize).toBe(MAX_SCANNED_FILE_SIZE);
      expect(debug).toHaveBeenCalledWith(
        "Ignoring stored config 'secrets.maxFileSize': '2MB' is invalid. Expected a non-negative integer of at most 15 digits.",
      );
    } finally {
      debug.mockRestore();
    }
  });

  it('falls back to the default size limit for a hand-edited value too large to pass on as plain digits', async () => {
    // Number('1000000000000000000000') prints as '1e+21', which sonar-secrets would reject on every scan.
    writeConfig(['secrets.maxFileSize=1000000000000000000000']);
    const debug = spyOn(logger, 'debug');

    try {
      expect((await loadSecretsScanSettings(workDir)).maxFileSize).toBe(MAX_SCANNED_FILE_SIZE);
      expect(debug).toHaveBeenCalledWith(
        "Ignoring stored config 'secrets.maxFileSize': '1000000000000000000000' is invalid. Expected a non-negative integer of at most 15 digits.",
      );
    } finally {
      debug.mockRestore();
    }
  });

  it('keeps the largest accepted size limit as plain digits', async () => {
    writeConfig(['secrets.maxFileSize=999999999999999']);

    const { maxFileSize } = await loadSecretsScanSettings(workDir);

    expect(String(maxFileSize)).toBe('999999999999999');
  });

  it('falls back to false, logging it, for a hand-edited boolean that is not true or false', async () => {
    writeConfig(['secrets.demoMode=yes', 'secrets.disableEntropyFilter=TRUE']);
    const debug = spyOn(logger, 'debug');

    try {
      const settings = await loadSecretsScanSettings(workDir);

      expect(settings.demoMode).toBe(false);
      expect(settings.disableEntropyFilter).toBe(false);
      expect(debug).toHaveBeenCalledWith(
        "Ignoring stored config 'secrets.demoMode': 'yes' is invalid. Allowed values: true, false.",
      );
      expect(debug).toHaveBeenCalledWith(
        "Ignoring stored config 'secrets.disableEntropyFilter': 'TRUE' is invalid. Allowed values: true, false.",
      );
    } finally {
      debug.mockRestore();
    }
  });

  it('falls back to the defaults, naming each ignored key, when the config file cannot be read', async () => {
    // A directory where the config file should be makes every read of it fail.
    mkdirSync(join(testSonarUserHome, 'sonarqube-cli', CLI_CONFIG_FILE_NAME), { recursive: true });
    const debug = spyOn(logger, 'debug');

    try {
      expect(await loadSecretsScanSettings(workDir)).toEqual(DEFAULT_SECRETS_SCAN_SETTINGS);
      const ignoredKeys = debug.mock.calls
        .map(([message]) => /^Ignoring stored config '([^']+)'/.exec(String(message))?.[1])
        .filter(Boolean);
      expect(ignoredKeys.sort()).toEqual([
        'secrets.demoMode',
        'secrets.disableEntropyFilter',
        'secrets.disableKnownFakeSecretFilter',
        'secrets.disableTestFileDetection',
        'secrets.exclude',
        'secrets.maxFileSize',
      ]);
    } finally {
      debug.mockRestore();
    }
  });

  it('resolves relative exclusions against the current directory outside a git repository', async () => {
    const absolute = join(tmpdir(), 'elsewhere');
    writeConfig([`secrets.exclude= vendor , ${absolute},, fixtures/keys.txt `]);

    expect((await loadSecretsScanSettings(workDir)).exclusions).toEqual([
      join(workDir, 'vendor'),
      absolute,
      join(workDir, 'fixtures', 'keys.txt'),
    ]);
  });

  it('resolves relative exclusions against the repository root from a subdirectory', async () => {
    spawnSync('git', ['init', '--quiet'], { cwd: workDir });
    const subDir = join(workDir, 'packages', 'api');
    mkdirSync(subDir, { recursive: true });
    writeConfig(['secrets.exclude=vendor']);

    expect((await loadSecretsScanSettings(subDir)).exclusions).toEqual([
      join(canonicalizePath(workDir), 'vendor'),
    ]);
  });
});
