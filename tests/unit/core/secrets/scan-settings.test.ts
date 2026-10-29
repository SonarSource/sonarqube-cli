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

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CLI_CONFIG_FILE_NAME, ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';
import {
  DEFAULT_SECRETS_SCAN_SETTINGS,
  loadSecretsScanSettings,
} from '@/core/secrets/scan-settings.ts';

const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];
let testSonarUserHome: string;

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'secrets-scan-settings-home-'));
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;
});

afterEach(async () => {
  await rm(testSonarUserHome, { recursive: true, force: true });
  if (previousSonarUserHome === undefined) {
    delete process.env[ENV_SONAR_USER_HOME];
  } else {
    process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
  }
});

// The other `secrets.*` cases live in analyze-secrets.test.ts: the integration harness reads the config file
// before every run, so it cannot leave one unreadable.
describe('loadSecretsScanSettings', () => {
  it('falls back to the defaults, naming each ignored key, when the config file cannot be read', async () => {
    // A directory where the config file should be makes every read of it fail.
    mkdirSync(join(testSonarUserHome, 'sonarqube-cli', CLI_CONFIG_FILE_NAME), { recursive: true });
    const debug = spyOn(logger, 'debug');

    try {
      expect(await loadSecretsScanSettings()).toEqual(DEFAULT_SECRETS_SCAN_SETTINGS);
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
});
