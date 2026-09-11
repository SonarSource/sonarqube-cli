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

// Integration tests for `quality-gate status <file>` - coverage/duplications conditions
// evaluated against the resolved file/directory's own value, not the project's.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('quality-gate status <file> — coverage/duplications', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'reports a failing coverage condition for a single file, using the file’s own value',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('OK')
            .withConditions([
              {
                status: 'OK',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '94.4',
              },
            ])
            .withComponentsTreeItems([{ path: 'src/checkout.ts', qualifier: 'FIL' }])
            .withComponentMeasures('src/checkout.ts', [{ metric: 'new_coverage', value: '31.0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/checkout.ts --project my-project --format json`,
      );

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.status).toBe('ERROR');
      expect(parsed.qualityGate.file).toBe('src/checkout.ts');
      expect(parsed.qualityGate.conditions).toEqual([
        expect.objectContaining({
          metric: 'new_coverage',
          status: 'ERROR',
          actualValue: '31.0',
          formattedActualValue: '31.0%',
          formattedThreshold: '80%',
        }),
      ]);
    },
    { timeout: 15000 },
  );

  it(
    'reports a clean file with no failing conditions and exit code 0',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('OK')
            .withConditions([
              {
                status: 'OK',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '94.4',
              },
            ])
            .withComponentsTreeItems([{ path: 'src/checkout.ts', qualifier: 'FIL' }])
            .withComponentMeasures('src/checkout.ts', [{ metric: 'new_coverage', value: '96.0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/checkout.ts --project my-project --format json`,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.status).toBe('OK');
      expect(parsed.qualityGate.conditions).toEqual([]);
    },
    { timeout: 15000 },
  );

  it(
    '--all includes the passing condition for a clean file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('OK')
            .withConditions([
              {
                status: 'OK',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '94.4',
              },
            ])
            .withComponentsTreeItems([{ path: 'src/checkout.ts', qualifier: 'FIL' }])
            .withComponentMeasures('src/checkout.ts', [{ metric: 'new_coverage', value: '96.0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/checkout.ts --project my-project --format json --all`,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.conditions).toEqual([
        expect.objectContaining({ metric: 'new_coverage', status: 'OK', actualValue: '96.0' }),
      ]);
    },
    { timeout: 15000 },
  );

  it(
    'reports a failing coverage condition for a directory using its own aggregated value, with a worst-N breakdown of files within it',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('OK')
            .withConditions([
              {
                status: 'OK',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '94.4',
              },
            ])
            .withComponentsTreeItems([{ path: 'src/checkout', qualifier: 'DIR' }])
            .withComponentMeasures('src/checkout', [{ metric: 'new_coverage', value: '62.2' }])
            .withComponentTreeFiles('new_coverage', [
              { path: 'src/checkout/cart.ts', value: '45.2' },
              { path: 'src/checkout/payment.ts', value: '58.6' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/checkout --project my-project --format json`,
      );

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions[0];
      expect(condition.actualValue).toBe('62.2');
      expect(condition.breakdown).toEqual({
        category: 'coverage',
        totalCount: 2,
        fetchedCount: 2,
        entries: [
          { path: 'src/checkout/cart.ts', value: '45.2', formattedValue: '45.2%' },
          { path: 'src/checkout/payment.ts', value: '58.6', formattedValue: '58.6%' },
        ],
      });
    },
    { timeout: 15000 },
  );

  it(
    'renders the file-scoped table with the "Quality Gate · <file>" header and no project-level worst-N section',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('OK')
            .withConditions([
              {
                status: 'OK',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '94.4',
              },
            ])
            .withComponentsTreeItems([{ path: 'src/checkout.ts', qualifier: 'FIL' }])
            .withComponentMeasures('src/checkout.ts', [{ metric: 'new_coverage', value: '31.0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/checkout.ts --project my-project --format table`,
      );

      const lines = result.stdout.split('\n');
      expect(lines[0]).toContain('Quality Gate · src/checkout.ts');
      expect(lines.some((l) => l.includes('Project:'))).toBe(false);
      expect(lines.some((l) => l.includes('31.0%'))).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'a nonexistent file path is reported clearly and exits 2, not treated as zero conditions',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK').withConditions([]))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/does-not-exist.ts --project my-project`,
      );

      expect(result.exitCode).toBe(2);
      const output = result.stdout + result.stderr;
      expect(output).toContain('No file or directory matching');
    },
    { timeout: 15000 },
  );
});
