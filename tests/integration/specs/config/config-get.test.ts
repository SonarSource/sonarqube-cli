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
// Value-set scenarios (non-sensitive value printed, sensitive value redacted) are
// covered at the unit level (tests/unit/commands/config/get.test.ts) since seeding the
// generic config store end-to-end requires `config set` (CLI-1119), not yet wired to a
// CLI command.

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
      expect(result.stdout + result.stderr).toContain('Not set.');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and states it is not set for an unset, sensitive key',
    async () => {
      const result = await harness.run('config get network.tls.clientPassphrase');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Not set.');
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
