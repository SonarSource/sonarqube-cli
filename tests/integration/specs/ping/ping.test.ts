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

// Integration tests for `sonar ping`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { TestHarness } from '../../harness';

describe('sonar ping', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 1 and shows auth error when not authenticated',
    async () => {
      const result = await harness.run('ping');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('sonar auth login');
    },
    { timeout: 15000 },
  );

  it(
    'prints server status in text format by default',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();
      harness.withAuth(server.baseUrl(), 'my-token');

      const result = await harness.run('ping');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Server:');
      expect(result.stdout).toContain(server.baseUrl());
      expect(result.stdout).toContain('Status:');
      expect(result.stdout).toContain('UP');
      expect(result.stdout).toContain('Version:');
    },
    { timeout: 15000 },
  );

  it(
    'prints server status as JSON when --json flag is passed',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('my-token').start();
      harness.withAuth(server.baseUrl(), 'my-token');

      const result = await harness.run('ping --json');

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.serverUrl).toBe(server.baseUrl());
      expect(parsed.status).toBe('UP');
      expect(parsed.version).toBeDefined();
    },
    { timeout: 15000 },
  );
});
