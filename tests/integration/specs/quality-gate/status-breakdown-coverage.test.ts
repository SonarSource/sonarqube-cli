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

// Integration tests for the coverage category breakdown in `quality-gate status`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('quality-gate status — coverage breakdown', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'includes a coverage breakdown in JSON for a failing new_coverage condition',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '62.4',
              },
            ])
            .withComponentTreeFiles('new_coverage', [
              { path: 'src/checkout.ts', value: '31.0' },
              { path: 'src/cart.ts', value: '45.2' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_coverage',
      );
      expect(condition.breakdown).toEqual({
        totalCount: 2,
        fetchedCount: 2,
        entries: [
          { path: 'src/checkout.ts', value: '31.0', formattedValue: '31.0%' },
          { path: 'src/cart.ts', value: '45.2', formattedValue: '45.2%' },
        ],
      });
    },
    { timeout: 15000 },
  );
  it(
    'includes a coverage breakdown in JSON for a failing overall coverage condition',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'coverage', type: 'PERCENT', name: 'Coverage' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '62.4',
              },
            ])
            .withComponentTreeFiles('coverage', [
              { path: 'src/checkout.ts', value: '31.0' },
              { path: 'src/cart.ts', value: '45.2' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'coverage',
      );
      expect(condition.breakdown).toEqual({
        totalCount: 2,
        fetchedCount: 2,
        entries: [
          { path: 'src/checkout.ts', value: '31.0', formattedValue: '31.0%' },
          { path: 'src/cart.ts', value: '45.2', formattedValue: '45.2%' },
        ],
      });
    },
    { timeout: 15000 },
  );
  it(
    'rounds a full-precision component_tree coverage value to one decimal place',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '62.4',
              },
            ])
            // Real SonarQube Cloud project_status conditions arrive pre-rounded, but
            // component_tree per-file measures don't - e.g. 38.84615384615385.
            .withComponentTreeFiles('new_coverage', [
              { path: 'src/checkout.ts', value: '38.84615384615385' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_coverage',
      );
      expect(condition.breakdown).toEqual({
        totalCount: 1,
        fetchedCount: 1,
        entries: [
          {
            path: 'src/checkout.ts',
            value: '38.84615384615385',
            formattedValue: '38.8%',
          },
        ],
      });
    },
    { timeout: 15000 },
  );
  it(
    "rounds a full-precision component_tree coverage value to the metric catalog's own decimalScale, not always one",
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          { key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code', decimalScale: 2 },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '62.4',
              },
            ])
            .withComponentTreeFiles('new_coverage', [
              { path: 'src/checkout.ts', value: '38.84615384615385' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_coverage',
      );
      expect(condition.breakdown).toEqual({
        totalCount: 1,
        fetchedCount: 1,
        entries: [
          {
            path: 'src/checkout.ts',
            value: '38.84615384615385',
            formattedValue: '38.85%',
          },
        ],
      });
    },
    { timeout: 15000 },
  );
  it(
    'renders the coverage breakdown in the table, nested under its condition, without long paths colliding with the value',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '62.4',
              },
            ])
            .withComponentTreeFiles('new_coverage', [
              { path: 'src/checkout.ts', value: '31.0' },
              { path: 'src/a-very-long-file-name-that-should-not-collide.ts', value: '45.2' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      const lines = result.stdout.split('\n');
      const shortLine = lines.find((l) => l.includes('src/checkout.ts'));
      const longLine = lines.find((l) =>
        l.includes('src/a-very-long-file-name-that-should-not-collide.ts'),
      );
      expect(shortLine).toBeDefined();
      expect(longLine).toBeDefined();
      // Both value columns must start at the same offset, proving the short path was padded
      // out to the long path's width rather than butting straight up against its own value.
      expect(shortLine?.indexOf('31.0')).toBe(longLine?.indexOf('45.2'));
    },
    { timeout: 15000 },
  );
  it(
    'renders the coverage breakdown in the table for a failing overall coverage condition',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'coverage', type: 'PERCENT', name: 'Coverage' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '62.4',
              },
            ])
            .withComponentTreeFiles('coverage', [
              { path: 'src/checkout.ts', value: '31.0' },
              { path: 'src/cart.ts', value: '45.2' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      const lines = result.stdout.split('\n');
      const conditionIndex = lines.findIndex((l) => l.includes('Coverage'));
      expect(lines[conditionIndex + 1]).toContain('src/checkout.ts');
      // Asserting the '%' suffix, not just the bare number, proves the table renders
      // `formattedValue`, not the raw `value` the JSON breakdown also carries.
      expect(lines[conditionIndex + 1]).toContain('31.0%');
      expect(lines[conditionIndex + 2]).toContain('src/cart.ts');
      expect(lines[conditionIndex + 2]).toContain('45.2%');
    },
    { timeout: 15000 },
  );
  it(
    'includes the coverage breakdown when --category coverage is passed explicitly',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '62.4',
              },
            ])
            .withComponentTreeFiles('new_coverage', [{ path: 'src/checkout.ts', value: '31.0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --category coverage --format json`,
      );

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_coverage',
      );
      expect(condition.breakdown).toEqual({
        totalCount: 1,
        fetchedCount: 1,
        entries: [{ path: 'src/checkout.ts', value: '31.0', formattedValue: '31.0%' }],
      });
    },
    { timeout: 15000 },
  );
});
