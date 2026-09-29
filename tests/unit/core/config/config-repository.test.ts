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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { getConfigValue, setConfigValue } from '@/core/config/config-repository.ts';
import type { ConfigKey } from '@/core/config/config-schema.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { clearSecretCache, getConfigSecret, saveConfigSecret } from '@/core/host/keychain.ts';

import { createKeychainTestHandle } from '../host/keychain-test-handle.ts';

const keychain = createKeychainTestHandle();
const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];
let testSonarUserHome: string;
let testConfigFile: string;

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-config-repository-test-'));
  testConfigFile = join(testSonarUserHome, 'sonarqube-cli', 'cli-config.properties');
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;
  keychain.setup();
});

afterEach(async () => {
  keychain.teardown();
  await rm(testSonarUserHome, { recursive: true, force: true });
  if (previousSonarUserHome === undefined) {
    delete process.env[ENV_SONAR_USER_HOME];
  } else {
    process.env[ENV_SONAR_USER_HOME] = previousSonarUserHome;
  }
});

describe('config repository', () => {
  it('stores each value in the store matching its sensitivity', async () => {
    await setConfigValue('log.level', 'DEBUG');
    await setConfigValue('network.proxy.https', 'http://user:secret@proxy');
    clearSecretCache();

    // non-sensitive: config file
    expect(readFileSync(testConfigFile, 'utf-8')).toBe('log.level=DEBUG\n');
    expect(await getConfigSecret('log.level')).toBeNull();
    // sensitive: keychain
    expect(await getConfigSecret('network.proxy.https')).toBe('http://user:secret@proxy');

    expect(await getConfigValue('log.level')).toBe('DEBUG');
    expect(await getConfigValue('network.proxy.https')).toBe('http://user:secret@proxy');
  });

  it('reads each key only from the store matching its sensitivity', async () => {
    mkdirSync(dirname(testConfigFile), { recursive: true });
    writeFileSync(testConfigFile, 'network.proxy.https=http://from-file\n', 'utf-8');
    await saveConfigSecret('log.level', 'DEBUG');

    // sensitive: the config file is ignored
    expect(await getConfigValue('network.proxy.https')).toBeUndefined();
    // non-sensitive: the keychain is ignored
    expect(await getConfigValue('log.level')).toBeUndefined();
  });

  it('returns undefined for unset keys in either store', async () => {
    expect(await getConfigValue('log.level')).toBeUndefined();
    expect(await getConfigValue('network.tls.clientPassphrase')).toBeUndefined();
  });

  it('rejects an unknown key without writing anything', async () => {
    const unknownKey = 'unknown.key' as ConfigKey;

    const getError = await getConfigValue(unknownKey).catch((error: unknown) => error);
    const setError = await setConfigValue(unknownKey, 'value').catch((error: unknown) => error);

    expect(getError).toBeInstanceOf(InvalidOptionError);
    expect(setError).toBeInstanceOf(InvalidOptionError);
    expect(existsSync(testConfigFile)).toBe(false);
    expect(await getConfigSecret(unknownKey)).toBeNull();
  });

  it('rejects a value outside the allowed values without writing anything', async () => {
    const error = await setConfigValue('log.level', 'VERBOSE').catch((error: unknown) => error);

    expect(error).toBeInstanceOf(InvalidOptionError);
    expect(existsSync(testConfigFile)).toBe(false);
  });
});
