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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('loadState', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'fails the command and leaves the file untouched when state.json is corrupt',
    async () => {
      harness.state().withRawState('not-valid-json');

      const result = await harness.run('config telemetry');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Failed to read state');
      expect(output).toContain('The state file may be corrupted. Inspect or remove it at');
      // The corrupt file must not be overwritten with default state.
      expect(harness.stateJsonFile.asText()).toBe('not-valid-json');
    },
    { timeout: 15000 },
  );

  it(
    'runs the command normally when state.json is valid',
    async () => {
      const result = await harness.run('config telemetry');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Telemetry is currently');
      expect(() => {
        harness.stateJsonFile.asJson();
      }).not.toThrow();
    },
    { timeout: 15000 },
  );
});
