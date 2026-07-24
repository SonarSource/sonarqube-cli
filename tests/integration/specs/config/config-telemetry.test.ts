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

// Integration tests for `config telemetry` — CLI wiring and state persistence.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getDefaultState } from '@/core/state/state.ts';

import { version as CURRENT_CLI_VERSION } from '../../../../package.json';
import { TestHarness } from '../../harness';

describe('config telemetry', () => {
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
      const result = await harness.run('config telemetry --enabled --disabled');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('Cannot use both --enabled and --disabled');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and reports DO_NOT_TRACK status when no flags are provided',
    async () => {
      const result = await harness.run('config telemetry');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('DO_NOT_TRACK');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0, disables telemetry in state, and reports success when --disabled is provided',
    async () => {
      const result = await harness.run('config telemetry --disabled');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Telemetry disabled');
      expect((await harness.stateJsonFile.asJson()).telemetry.enabled).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'reports telemetry disabled when DO_NOT_TRACK is set and persisted preference is enabled',
    async () => {
      const state = getDefaultState(CURRENT_CLI_VERSION);
      state.telemetry.enabled = true;
      harness.state().withRawState(JSON.stringify(state));

      const result = await harness.run('config telemetry');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('DO_NOT_TRACK');
      expect(result.stdout + result.stderr).toContain('disabled');
    },
    { timeout: 15000 },
  );

  it(
    'persists enabled preference while reporting DO_NOT_TRACK override when --enabled is provided',
    async () => {
      const result = await harness.run('config telemetry --enabled');

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('preference saved as enabled');
      expect(output).toContain('DO_NOT_TRACK');
      expect(output).not.toContain('Telemetry enabled.');
      expect((await harness.stateJsonFile.asJson()).telemetry.enabled).toBe(true);
    },
    { timeout: 15000 },
  );
});
