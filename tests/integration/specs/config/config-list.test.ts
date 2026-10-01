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

// Integration tests for `config list` — CLI wiring, exit codes, and redaction.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CONFIG_KEY_DEFINITIONS } from '@/core/config/config-schema.ts';

import { TestHarness } from '../../harness';

describe('config list', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 0 and prints every key from the allowlist, unset ones as (not set)',
    async () => {
      const result = await harness.run('config list');

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(CONFIG_KEY_DEFINITIONS.length);
      for (const definition of CONFIG_KEY_DEFINITIONS) {
        expect(result.stdout).toContain(`${definition.key}=(not set)`);
      }
    },
    { timeout: 15000 },
  );

  it(
    'shows the current value for a set, non-sensitive key',
    async () => {
      const set = await harness.run('config set log.level DEBUG');
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config list');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('log.level=DEBUG');
    },
    { timeout: 15000 },
  );

  it(
    'never prints the real value for a set, sensitive key',
    async () => {
      const set = await harness.run(
        'config set network.tls.clientPassphrase super-secret-passphrase',
      );
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config list');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('network.tls.clientPassphrase=(hidden)');
      expect(result.stdout).not.toContain('super-secret-passphrase');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and prints a table with every key from the allowlist with --format table',
    async () => {
      const set = await harness.run(
        'config set network.tls.clientPassphrase super-secret-passphrase',
      );
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config list --format table');

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      // header + separator + one row per key
      expect(lines).toHaveLength(CONFIG_KEY_DEFINITIONS.length + 2);
      expect(result.stdout).toContain('KEY');
      expect(result.stdout).toContain('VALUE');
      for (const definition of CONFIG_KEY_DEFINITIONS) {
        expect(result.stdout).toContain(definition.key);
      }
      expect(result.stdout).toContain('network.tls.clientPassphrase');
      expect(result.stdout).toContain('(hidden)');
      expect(result.stdout).not.toContain('super-secret-passphrase');
    },
    { timeout: 15000 },
  );

  it(
    'prints every key as a JSON array, never the real value for a set, sensitive key',
    async () => {
      const set = await harness.run(
        'config set network.tls.clientPassphrase super-secret-passphrase',
      );
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config list --format json');

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload).toHaveLength(CONFIG_KEY_DEFINITIONS.length);
      expect(payload).toEqual(
        expect.arrayContaining([
          { key: 'network.tls.clientPassphrase', sensitive: true, set: true },
          { key: 'log.level', sensitive: false, set: false },
          { key: 'telemetry.enabled', sensitive: false, set: false },
        ]),
      );
      expect(result.stdout).not.toContain('super-secret-passphrase');
    },
    { timeout: 15000 },
  );

  it(
    '--only-set shows only keys that currently have a value',
    async () => {
      const set = await harness.run('config set log.level DEBUG');
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config list --only-set');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('log.level=DEBUG');
    },
    { timeout: 15000 },
  );

  it(
    '--only-set with --format json includes only set keys',
    async () => {
      const set = await harness.run(
        'config set network.tls.clientPassphrase super-secret-passphrase',
      );
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config list --only-set --format json');

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        { key: 'network.tls.clientPassphrase', sensitive: true, set: true },
      ]);
      expect(result.stdout).not.toContain('super-secret-passphrase');
    },
    { timeout: 15000 },
  );

  it(
    '--only-set prints a message instead of an empty list when nothing is set',
    async () => {
      const result = await harness.run('config list --only-set');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('No config values are set.');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 for an invalid --format value',
    async () => {
      const result = await harness.run('config list --format xml');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "option '--format <format>' argument 'xml' is invalid",
      );
    },
    { timeout: 15000 },
  );
});
