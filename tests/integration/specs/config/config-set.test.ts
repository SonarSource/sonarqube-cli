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

// Integration tests for `config set` — CLI wiring, exit codes, and store routing.
// Reads the config file and keychain file the harness writes to directly, so no
// harness seeding is needed to observe what `set` persisted.

import { existsSync, readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CLI_CONFIG_FILE_NAME } from '@/core/config-constants.ts';

import { TestHarness } from '../../harness';

describe('config set', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'stores a non-sensitive value in the config file',
    async () => {
      const result = await harness.run('config set log.level DEBUG');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain("Saved 'log.level'.");
      expect(harness.cliHome.file(CLI_CONFIG_FILE_NAME).asText()).toBe('log.level=DEBUG\n');
      expect(existsSync(harness.keychainJsonFile)).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'stores a sensitive value in the OS keychain, never in the config file',
    async () => {
      const result = await harness.run('config set network.tls.clientPassphrase super-secret');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain("Saved 'network.tls.clientPassphrase'.");
      const keychain = JSON.parse(readFileSync(harness.keychainJsonFile, 'utf-8'));
      expect(keychain.tokens['config/network.tls.clientPassphrase']).toBe('super-secret');
      expect(harness.cliHome.exists(CLI_CONFIG_FILE_NAME)).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 and writes nothing for an unknown key',
    async () => {
      const result = await harness.run('config set not.a.real.key value');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain("Unknown config key 'not.a.real.key'");
      expect(harness.cliHome.exists(CLI_CONFIG_FILE_NAME)).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 and writes nothing for a value outside the allowed values',
    async () => {
      const result = await harness.run('config set log.level VERBOSE');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain("Invalid value 'VERBOSE'");
      expect(harness.cliHome.exists(CLI_CONFIG_FILE_NAME)).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'prompts for the value interactively, without echoing it, when omitted',
    async () => {
      const session = harness.runInteractive('config set network.tls.clientPassphrase', {
        extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1' },
      });
      await session.waitText("Value for 'network.tls.clientPassphrase'");
      session.write('super-secret-passphrase');
      session.keyEnter();
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('super-secret-passphrase');
      const keychain = JSON.parse(readFileSync(harness.keychainJsonFile, 'utf-8'));
      expect(keychain.tokens['config/network.tls.clientPassphrase']).toBe(
        'super-secret-passphrase',
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with an error and writes nothing when the interactive prompt is cancelled',
    async () => {
      const session = harness.runInteractive('config set network.tls.clientPassphrase', {
        extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1' },
      });
      await session.waitText("Value for 'network.tls.clientPassphrase'");
      session.keyCtrlC();
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "Aborted: no value provided for 'network.tls.clientPassphrase'.",
      );
      expect(existsSync(harness.keychainJsonFile)).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 and writes nothing when the prompted value is empty or whitespace-only',
    async () => {
      const session = harness.runInteractive('config set network.tls.clientPassphrase', {
        extraEnv: { SONARQUBE_CLI_MOCK_TTY: '1' },
      });
      await session.waitText("Value for 'network.tls.clientPassphrase'");
      session.write('   ');
      session.keyEnter();
      const result = await session.waitFinish();

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain(
        "Value for config key 'network.tls.clientPassphrase' must not be empty.",
      );
      expect(result.stdout + result.stderr).toContain(
        "If you meant to unset it, run 'sonar config unset network.tls.clientPassphrase'.",
      );
      expect(existsSync(harness.keychainJsonFile)).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and writes nothing when the value is omitted on a non-interactive terminal',
    async () => {
      const result = await harness.run('config set network.tls.clientPassphrase');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Non-interactive mode requires a value.');
      expect(existsSync(harness.keychainJsonFile)).toBe(false);
    },
    { timeout: 15000 },
  );
});
