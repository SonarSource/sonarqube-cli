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

import { mock, describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const testCliDir = join(tmpdir(), `sonar-post-update-test-${Date.now()}`);
const testStateFile = join(testCliDir, 'state.json');

void mock.module('../../src/lib/config-constants.js', () => ({
  APP_NAME: 'sonarqube-cli',
  CLI_DIR: testCliDir,
  STATE_FILE: testStateFile,
  LOG_DIR: join(testCliDir, 'logs'),
  LOG_FILE: join(testCliDir, 'logs/sonarqube-cli.log'),
  BIN_DIR: join(testCliDir, 'bin'),
  SONARSOURCE_BINARIES_URL: 'https://binaries.sonarsource.com',
  SONAR_SECRETS_DIST_PREFIX: 'CommercialDistribution/sonar-secrets',
  UPDATE_SCRIPT_BASE_URL:
    'https://raw.githubusercontent.com/SonarSource/sonarqube-cli/refs/heads/master/user-scripts',
  SONARCLOUD_HOSTNAME: 'sonarcloud.io',
  SONARCLOUD_URL: 'https://sonarcloud.io',
  SONARCLOUD_API_URL: 'https://api.sonarcloud.io',
  AUTH_PORT_START: 64120,
  AUTH_PORT_COUNT: 11,
}));

void mock.module('../../package.json', () => ({ version: '2.0.0' }));

const { runPostUpdateActions } = await import('../../src/lib/post-update.js');
import { getDefaultState } from '../../src/lib/state.js';

function cleanup(): void {
  if (existsSync(testCliDir)) {
    rmSync(testCliDir, { recursive: true, force: true });
  }
}

describe('runPostUpdateActions', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('does nothing when state file does not exist (fresh install)', async () => {
    await runPostUpdateActions();
    expect(existsSync(testStateFile)).toBe(false);
  });

  it('does nothing when state version equals current version', async () => {
    mkdirSync(testCliDir, { recursive: true });
    const state = getDefaultState('2.0.0');
    const original = JSON.stringify(state);
    writeFileSync(testStateFile, original, 'utf-8');

    await runPostUpdateActions();

    const after = JSON.parse(readFileSync(testStateFile, 'utf-8')) as {
      config: { cliVersion: string };
    };
    expect(after.config.cliVersion).toBe('2.0.0');
  });

  it('does nothing when state version is ahead of current version', async () => {
    mkdirSync(testCliDir, { recursive: true });
    const state = getDefaultState('3.0.0');
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await runPostUpdateActions();

    const after = JSON.parse(readFileSync(testStateFile, 'utf-8')) as {
      config: { cliVersion: string };
    };
    expect(after.config.cliVersion).toBe('3.0.0');
  });

  it('bumps state.config.cliVersion when current version is newer', async () => {
    mkdirSync(testCliDir, { recursive: true });
    const state = getDefaultState('1.0.0');
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await runPostUpdateActions();

    const after = JSON.parse(readFileSync(testStateFile, 'utf-8')) as {
      config: { cliVersion: string };
    };
    expect(after.config.cliVersion).toBe('2.0.0');
  });

  it('preserves existing state fields when bumping version', async () => {
    mkdirSync(testCliDir, { recursive: true });
    const state = getDefaultState('1.0.0');
    state.auth.isAuthenticated = true;
    writeFileSync(testStateFile, JSON.stringify(state), 'utf-8');

    await runPostUpdateActions();

    const after = JSON.parse(readFileSync(testStateFile, 'utf-8')) as {
      config: { cliVersion: string };
      auth: { isAuthenticated: boolean };
    };
    expect(after.config.cliVersion).toBe('2.0.0');
    expect(after.auth.isAuthenticated).toBe(true);
  });
});
