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

// Integration tests for `config unset` — CLI wiring, exit codes, and store routing.
// Seeds values via `config set` and reads the config file / keychain file the
// harness writes to directly, so no harness seeding helper is needed.

import { existsSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CLI_CONFIG_FILE_NAME } from '@/core/config-constants.ts';

import { TestHarness } from '../../harness';

describe('config unset', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'removes a non-sensitive value from the config file',
    async () => {
      const set = await harness.run('config set log.level DEBUG');
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config unset log.level');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain("Removed 'log.level'.");
      expect(harness.cliHome.file(CLI_CONFIG_FILE_NAME).asText()).toBe('');
    },
    { timeout: 15000 },
  );

  it(
    'removes a sensitive value from the OS keychain',
    async () => {
      const set = await harness.run('config set network.tls.clientPassphrase super-secret');
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config unset network.tls.clientPassphrase');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "Removed 'network.tls.clientPassphrase' from the system keychain.",
      );
      const keychain = JSON.parse(readFileSync(harness.keychainJsonFile, 'utf-8'));
      expect(keychain.tokens['config/network.tls.clientPassphrase']).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'is a no-op and writes nothing for a key that is not currently set',
    async () => {
      const result = await harness.run('config unset log.level');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain("Removed 'log.level'.");
      expect(harness.cliHome.exists(CLI_CONFIG_FILE_NAME)).toBe(false);
      expect(existsSync(harness.keychainJsonFile)).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 and writes nothing for an unknown key',
    async () => {
      const result = await harness.run('config unset not.a.real.key');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain("Unknown config key 'not.a.real.key'");
      expect(harness.cliHome.exists(CLI_CONFIG_FILE_NAME)).toBe(false);
    },
    { timeout: 15000 },
  );
});
