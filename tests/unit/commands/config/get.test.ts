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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getConfig } from '@/commands/config/get.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { setConfigValue } from '@/core/config/config-repository.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';
import { createKeychainTestHandle } from '../../core/host/keychain-test-handle.ts';

const keychain = createKeychainTestHandle();
const previousSonarUserHome = process.env[ENV_SONAR_USER_HOME];
let testSonarUserHome: string;
let fake: FakeConsole;
let ctx: CommandInvocationContext;

beforeEach(async () => {
  testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-config-get-test-'));
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

describe('getConfig', () => {
  it('prints the stored value for a set, non-sensitive key', async () => {
    await setConfigValue('log.level', 'DEBUG');

    await getConfig('log.level', {}, ctx);

    expect(fake.findCall('print', 'DEBUG')).toBeDefined();
  });

  it('states it is not set for an unset, non-sensitive key', async () => {
    await getConfig('log.level', {}, ctx);

    expect(fake.findCall('print', 'Not set.')).toBeDefined();
  });

  it('never prints the real value for a set, sensitive key', async () => {
    await setConfigValue('network.tls.clientPassphrase', 'super-secret');

    await getConfig('network.tls.clientPassphrase', {}, ctx);

    expect(fake.findCall('print', 'Set (value hidden).')).toBeDefined();
    expect(fake.calls.some((call) => String(call.args[0]).includes('super-secret'))).toBe(false);
  });

  it('states it is not set for an unset, sensitive key without touching the keychain value', async () => {
    await getConfig('network.tls.clientPassphrase', {}, ctx);

    expect(fake.findCall('print', 'Not set.')).toBeDefined();
  });

  it('fails with an error for an unknown key', async () => {
    const error = await getConfig('unknown.key', {}, ctx).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(InvalidOptionError);
  });

  describe('--format json', () => {
    it('includes the value for a set, non-sensitive key', async () => {
      await setConfigValue('log.level', 'DEBUG');

      await getConfig('log.level', { format: 'json' }, ctx);

      const call = fake.findCall('print', '"key"');
      expect(call).toBeDefined();
      expect(JSON.parse(call!.args[0] as string)).toEqual({
        key: 'log.level',
        sensitive: false,
        set: true,
        value: 'DEBUG',
      });
    });

    it('omits value and reports set: false for an unset, non-sensitive key', async () => {
      await getConfig('log.level', { format: 'json' }, ctx);

      const call = fake.findCall('print', '"key"');
      expect(JSON.parse(call!.args[0] as string)).toEqual({
        key: 'log.level',
        sensitive: false,
        set: false,
      });
    });

    it('never includes a value for a set, sensitive key', async () => {
      await setConfigValue('network.tls.clientPassphrase', 'super-secret');

      await getConfig('network.tls.clientPassphrase', { format: 'json' }, ctx);

      const call = fake.findCall('print', '"key"');
      expect(JSON.parse(call!.args[0] as string)).toEqual({
        key: 'network.tls.clientPassphrase',
        sensitive: true,
        set: true,
      });
      expect(call!.args[0]).not.toContain('super-secret');
    });

    it('reports set: false for an unset, sensitive key', async () => {
      await getConfig('network.tls.clientPassphrase', { format: 'json' }, ctx);

      const call = fake.findCall('print', '"key"');
      expect(JSON.parse(call!.args[0] as string)).toEqual({
        key: 'network.tls.clientPassphrase',
        sensitive: true,
        set: false,
      });
    });
  });
});
