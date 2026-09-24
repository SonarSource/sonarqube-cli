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

// Integration tests for `config stats` — CLI wiring and state persistence.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('config stats', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 2 when both --enabled and --disabled are provided',
    async () => {
      const result = await harness.run('config stats --enabled --disabled');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('Cannot use both --enabled and --disabled');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and reports enabled status by default when no flags are provided',
    async () => {
      const result = await harness.run('config stats');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Stats collection is currently enabled.');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0, disables stats in state, and reports success when --disabled is provided',
    async () => {
      const result = await harness.run('config stats --disabled');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Stats collection disabled.');
      expect((await harness.stateJsonFile.asJson()).stats).toEqual({ enabled: false });
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0, enables stats in state, and reports success when --enabled is provided',
    async () => {
      const result = await harness.run('config stats --enabled');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Stats collection enabled.');
      expect((await harness.stateJsonFile.asJson()).stats).toEqual({ enabled: true });
    },
    { timeout: 15000 },
  );

  it(
    'reports disabled status once persisted',
    async () => {
      await harness.run('config stats --disabled');

      const result = await harness.run('config stats');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Stats collection is currently disabled.');
    },
    { timeout: 15000 },
  );
});
