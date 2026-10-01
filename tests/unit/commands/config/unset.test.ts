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

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { unsetConfig } from '@/commands/config/unset.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { getConfigValue, setConfigValue } from '@/core/config/config-repository.ts';
import { CLI_CONFIG_FILE_NAME, ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { getConfigSecret, saveConfigSecret } from '@/core/host/keychain.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';
import { createKeychainTestHandle } from '../../core/host/keychain-test-handle.ts';

const keychain = createKeychainTestHandle();
const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];
let testSonarUserHome: string;
let fake: FakeConsole;
let ctx: CommandInvocationContext;

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-config-unset-test-'));
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;
  keychain.setup();
  fake = new FakeConsole();
  ctx = new CommandInvocationContext(fake);
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

describe('unsetConfig', () => {
  it('removes a non-sensitive value from the config file and reports success', async () => {
    await setConfigValue('log.level', 'DEBUG');

    await unsetConfig('log.level', ctx);

    expect(await getConfigValue('log.level')).toBeUndefined();
    expect(fake.findCall('success', "Removed 'log.level'.")).toBeDefined();
  });

  it('removes a sensitive value from the OS keychain and reports success', async () => {
    await saveConfigSecret('network.tls.clientPassphrase', 'super-secret');

    await unsetConfig('network.tls.clientPassphrase', ctx);

    expect(await getConfigSecret('network.tls.clientPassphrase')).toBeNull();
    expect(
      fake.findCall('success', "Removed 'network.tls.clientPassphrase' from the system keychain."),
    ).toBeDefined();
  });

  it('is a no-op for a key that is not currently set, informing rather than claiming success', async () => {
    await unsetConfig('log.level', ctx);

    expect(await getConfigValue('log.level')).toBeUndefined();
    expect(fake.findCall('info', "'log.level' is not set; nothing to remove.")).toBeDefined();
    expect(fake.findCall('success', "Removed 'log.level'.")).toBeUndefined();
  });

  it('informs rather than claiming success for a sensitive key that is not currently set', async () => {
    await unsetConfig('network.tls.clientPassphrase', ctx);

    expect(
      fake.findCall('info', "'network.tls.clientPassphrase' is not set; nothing to remove."),
    ).toBeDefined();
    expect(fake.calls.some((call) => call.method === 'success')).toBe(false);
  });

  it('fails with an error for an unknown key and writes nothing', async () => {
    const error = await unsetConfig('unknown.key', ctx).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(InvalidOptionError);
    expect(existsSync(join(testSonarUserHome, 'sonarqube-cli', CLI_CONFIG_FILE_NAME))).toBe(false);
  });
});
