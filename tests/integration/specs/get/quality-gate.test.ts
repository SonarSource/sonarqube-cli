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

// Integration tests for `get quality-gate` via the compiled binary + fake SonarQube server

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('get quality-gate', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'reports OK and exits 0 when the quality gate passes',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project`);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate).toEqual({ status: 'OK', project: 'my-project' });
    },
    { timeout: 15000 },
  );

  it(
    'prints nothing but the JSON payload — project key resolution stays silent',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project`);

      expect(result.stderr).toBe('');
    },
    { timeout: 15000 },
  );

  it(
    'reports ERROR and exits 51 when the quality gate fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('ERROR'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate).toEqual({ status: 'ERROR', project: 'my-project' });
    },
    { timeout: 15000 },
  );

  it(
    'reports NOT_COMPUTED and exits 1 when the project has no quality gate status yet',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project`);

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate).toEqual({ status: 'NOT_COMPUTED', project: 'my-project' });
    },
    { timeout: 15000 },
  );
});
