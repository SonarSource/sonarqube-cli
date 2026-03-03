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

// Integration tests for `list projects` — requires state connection + keychain token
//
// Note: `list projects` reads auth directly from state+keychain (not `resolveAuth`),
// so env vars SONAR_CLI_TOKEN/SONAR_CLI_SERVER are NOT used here.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestHarness } from '../harness/index.js';

describe('list projects', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 and reports missing connection when no state exists',
    async () => {
      const result = await harness.run('list projects');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('No active connection found');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and reports missing token when connection exists but no keychain token',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('some-token').start();

      harness.env().withActiveConnection(server.baseUrl());
      // No withKeychainToken — token absent from keychain

      const result = await harness.run('list projects');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('No token found');
    },
    { timeout: 15000 },
  );

  it(
    'returns JSON with projects array when connection and token are valid',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withProject('proj-a')
        .withProject('proj-b')
        .start();

      harness
        .env()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'valid-token');

      const result = await harness.run('list projects');

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed.projects)).toBe(true);
      expect(parsed.projects.length).toBeGreaterThanOrEqual(2);
      const keys = parsed.projects.map((p: { key: string }) => p.key);
      expect(keys).toContain('proj-a');
      expect(keys).toContain('proj-b');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when keychain token is invalid (401)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('correct-token')
        .withProject('some-project')
        .start();

      harness
        .env()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'wrong-token');

      const result = await harness.run('list projects');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('401');
    },
    { timeout: 15000 },
  );
});
