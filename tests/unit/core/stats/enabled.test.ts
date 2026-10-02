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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import * as configFile from '@/core/config/config-file.ts';
import { setConfigFileValue } from '@/core/config/config-file.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { isStatsCollectionEnabled } from '@/core/stats/enabled.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';

describe('isStatsCollectionEnabled', () => {
  let savedSonarUserHome: string | undefined;
  let testDir: string;

  beforeEach(() => {
    savedSonarUserHome = process.env[ENV_SONAR_USER_HOME];
    testDir = mkdtempSync(join(tmpdir(), 'stats-enabled-test-'));
    process.env[ENV_SONAR_USER_HOME] = testDir;
  });

  afterEach(() => {
    restoreEnv(ENV_SONAR_USER_HOME, savedSonarUserHome);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns true when unset in config', () => {
    expect(isStatsCollectionEnabled()).toBe(true);
  });

  it('returns false when disabled in config', () => {
    setConfigFileValue('stats.enabled', 'false');

    expect(isStatsCollectionEnabled()).toBe(false);
  });

  it('returns false (fails closed) when the config cannot be read', () => {
    const readSpy = spyOn(configFile, 'getConfigFileValue').mockImplementation(() => {
      throw new Error('unreadable config');
    });

    expect(isStatsCollectionEnabled()).toBe(false);

    readSpy.mockRestore();
  });
});
