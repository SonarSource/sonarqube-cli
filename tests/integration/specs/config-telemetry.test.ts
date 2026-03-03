/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Integration tests for `config telemetry`

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestHarness } from '../harness/index.js';

describe('config telemetry', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 when both --enabled and --disabled are provided',
    async () => {
      const result = await harness.run('config telemetry --enabled --disabled');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Cannot use both --enabled and --disabled');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and reports current status when no flags are provided',
    async () => {
      const result = await harness.run('config telemetry');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Telemetry is currently');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and enables telemetry when --enabled is provided',
    async () => {
      const result = await harness.run('config telemetry --enabled');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Telemetry enabled');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and disables telemetry when --disabled is provided',
    async () => {
      const result = await harness.run('config telemetry --disabled');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('Telemetry disabled');
    },
    { timeout: 15000 },
  );
});
