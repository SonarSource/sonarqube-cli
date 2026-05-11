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

// Integration tests for `api` — generic authenticated API requests

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('api', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 when not authenticated',
    async () => {
      const result = await harness.run('api get /api/system/status');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Not authenticated');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 for an invalid HTTP method',
    async () => {
      harness.withAuth('http://localhost:19999', 'fake-token');

      const result = await harness.run('api trace /api/system/status');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain("Invalid HTTP method 'trace'");
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when endpoint does not start with /',
    async () => {
      harness.withAuth('http://localhost:19999', 'fake-token');

      const result = await harness.run('api get api/system/status');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain("Endpoint must start with '/'");
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --data is used with GET',
    async () => {
      harness.withAuth('http://localhost:19999', 'fake-token');

      const result = await harness.run(`api get /api/system/status --data '{"k":"v"}'`);

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('--data is only valid for');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --data is used with DELETE',
    async () => {
      harness.withAuth('http://localhost:19999', 'fake-token');

      const result = await harness.run(`api delete /api/system/status --data '{"k":"v"}'`);

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('--data is only valid for');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --data is not valid JSON',
    async () => {
      harness.withAuth('http://localhost:19999', 'fake-token');

      const result = await harness.run('api post /api/system/status --data not-json');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('--data must be valid JSON');
    },
    { timeout: 15000 },
  );

  it(
    'returns response body from a successful GET request',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('valid-token').start();
      harness.withAuth(server.baseUrl(), 'valid-token');

      const result = await harness.run('api get /api/system/status');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"status"');
      expect(result.stdout).toContain('UP');
    },
    { timeout: 15000 },
  );

  it(
    'sends the correct HTTP method to the server',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('valid-token').start();
      harness.withAuth(server.baseUrl(), 'valid-token');

      await harness.run('api delete /api/authentication/validate');

      const requests = server.getRecordedRequests();
      const req = requests.find((r) => r.path === '/api/authentication/validate');
      expect(req?.method).toBe('DELETE');
    },
    { timeout: 15000 },
  );

  it(
    'accepts lowercase method names',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('valid-token').start();
      harness.withAuth(server.baseUrl(), 'valid-token');

      const result = await harness.run('api get /api/system/status');

      expect(result.exitCode).toBe(0);
      const requests = server.getRecordedRequests();
      const req = requests.find((r) => r.path === '/api/system/status');
      expect(req?.method).toBe('GET');
    },
    { timeout: 15000 },
  );

  it(
    'sends POST request with --data body',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('valid-token').start();
      harness.withAuth(server.baseUrl(), 'valid-token');

      const result = await harness.run(
        `api post /api/authentication/validate --data '{"key":"value"}'`,
      );

      expect(result.exitCode).toBe(0);
      const requests = server.getRecordedRequests();
      const req = requests.find((r) => r.path === '/api/authentication/validate');
      expect(req?.method).toBe('POST');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when server returns 401 for invalid token',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('correct-token').start();
      harness.withAuth(server.baseUrl(), 'wrong-token');

      const result = await harness.run(`api post /api/authentication/validate --data '{"k":"v"}'`);

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('401');
    },
    { timeout: 15000 },
  );
});
