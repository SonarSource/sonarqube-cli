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

// Integration tests for `config get` — CLI wiring and exit codes.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('config get', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 0 and states it is not set for an unset, non-sensitive key',
    async () => {
      const result = await harness.run('config get log.level');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('(not set)');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and states it is not set for an unset, sensitive key',
    async () => {
      const result = await harness.run('config get network.tls.clientPassphrase');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('(not set)');
    },
    { timeout: 15000 },
  );

  it(
    'prints the stored value for a set, non-sensitive key',
    async () => {
      const set = await harness.run('config set log.level DEBUG');
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config get log.level');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('DEBUG');
    },
    { timeout: 15000 },
  );

  it(
    'never prints the real value in text mode for a set, sensitive key',
    async () => {
      const set = await harness.run(
        'config set network.tls.clientPassphrase super-secret-passphrase',
      );
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config get network.tls.clientPassphrase');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('(hidden)');
      expect(result.stdout + result.stderr).not.toContain('super-secret-passphrase');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 for an unknown key',
    async () => {
      const result = await harness.run('config get not.a.real.key');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain("Unknown config key 'not.a.real.key'");
    },
    { timeout: 15000 },
  );

  it(
    'prints a JSON object with set: false for an unset key with --format json',
    async () => {
      const result = await harness.run('config get log.level --format json');

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ key: 'log.level', sensitive: false, set: false });
    },
    { timeout: 15000 },
  );

  it(
    'includes the value in JSON output for a set, non-sensitive key',
    async () => {
      const set = await harness.run('config set log.level DEBUG');
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config get log.level --format json');

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        key: 'log.level',
        sensitive: false,
        set: true,
        value: 'DEBUG',
      });
    },
    { timeout: 15000 },
  );

  it(
    'reports set: false without a value in JSON output for an unset, sensitive key',
    async () => {
      const result = await harness.run('config get network.tls.clientPassphrase --format json');

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        key: 'network.tls.clientPassphrase',
        sensitive: true,
        set: false,
      });
    },
    { timeout: 15000 },
  );

  it(
    'reports set: true but never the real value in JSON output for a set, sensitive key',
    async () => {
      const set = await harness.run(
        'config set network.tls.clientPassphrase super-secret-passphrase',
      );
      expect(set.exitCode).toBe(0);

      const result = await harness.run('config get network.tls.clientPassphrase --format json');

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        key: 'network.tls.clientPassphrase',
        sensitive: true,
        set: true,
      });
      expect(result.stdout).not.toContain('super-secret-passphrase');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 for an invalid --format value',
    async () => {
      const result = await harness.run('config get log.level --format xml');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "option '--format <format>' argument 'xml' is invalid",
      );
    },
    { timeout: 15000 },
  );
});
