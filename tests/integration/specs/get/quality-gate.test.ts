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
      expect(parsed.qualityGate).toEqual({ status: 'OK', project: 'my-project', conditions: [] });
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
        .withProject('my-project', (p) =>
          p.withProjectStatus('ERROR').withConditions([
            {
              status: 'ERROR',
              metricKey: 'new_coverage',
              comparator: 'LT',
              errorThreshold: '80',
              actualValue: '62.4',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate).toEqual({
        status: 'ERROR',
        project: 'my-project',
        conditions: [
          {
            status: 'ERROR',
            metric: 'new_coverage',
            comparator: 'LT',
            threshold: '80',
            actualValue: '62.4',
          },
        ],
      });
    },
    { timeout: 15000 },
  );

  it(
    'omits passing conditions from the default (failing-only) conditions list',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('ERROR').withConditions([
            {
              status: 'OK',
              metricKey: 'new_bugs',
              comparator: 'GT',
              errorThreshold: '0',
              actualValue: '0',
            },
            {
              status: 'ERROR',
              metricKey: 'new_coverage',
              comparator: 'LT',
              errorThreshold: '80',
              actualValue: '62.4',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project`);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.conditions).toEqual([
        {
          status: 'ERROR',
          metric: 'new_coverage',
          comparator: 'LT',
          threshold: '80',
          actualValue: '62.4',
        },
      ]);
    },
    { timeout: 15000 },
  );

  it(
    'renders a table with the bracket verdict and failing conditions',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('ERROR').withConditions([
            {
              status: 'ERROR',
              metricKey: 'new_coverage',
              comparator: 'LT',
              errorThreshold: '80',
              actualValue: '62.4',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project --format table`);

      expect(result.exitCode).toBe(51);
      expect(result.stdout).toContain('Quality Gate: [✗ Failed]');
      expect(result.stdout).toContain('Project:      my-project');
      expect(result.stdout).toContain('Conditions:');
      expect(result.stdout).toContain('new_coverage');
      expect(result.stdout).toContain('62.4');
      expect(result.stdout).toContain('(required ≥ 80)');
    },
    { timeout: 15000 },
  );

  it(
    'renders a passing table verdict with no conditions section',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project --format table`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Quality Gate: [✓ Passed]');
      expect(result.stdout).not.toContain('Conditions:');
    },
    { timeout: 15000 },
  );

  it(
    'rejects an invalid --format value',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project --format yaml`);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('yaml');
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
      expect(parsed.qualityGate).toEqual({
        status: 'NOT_COMPUTED',
        project: 'my-project',
        conditions: [],
      });
    },
    { timeout: 15000 },
  );
});
