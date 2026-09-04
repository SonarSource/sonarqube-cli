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

// Integration tests for the shared --category/--top breakdown mechanism in `quality-gate status`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('quality-gate status — breakdown', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'reports the total matching file count separately from the truncated worst-N entries',
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
              { path: 'src/a.ts', value: '10.0' },
              { path: 'src/b.ts', value: '20.0' },
              { path: 'src/c.ts', value: '30.0' },
              { path: 'src/d.ts', value: '40.0' },
              { path: 'src/e.ts', value: '50.0' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --top 2 --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_coverage',
      );
      expect(condition.breakdown).toEqual({
        totalCount: 5,
        fetchedCount: 2,
        entries: [
          { path: 'src/a.ts', value: '10.0', formattedValue: '10.0%' },
          { path: 'src/b.ts', value: '20.0', formattedValue: '20.0%' },
        ],
      });
    },
    { timeout: 15000 },
  );
  it(
    'excludes a fetched component with no readable value from entries, but not from fetchedCount',
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
              { path: 'src/generated.ts' }, // no measure for this metric - toBreakdownEntry drops it
              { path: 'src/cart.ts', value: '45.2' },
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
        totalCount: 3,
        fetchedCount: 3,
        entries: [
          { path: 'src/checkout.ts', value: '31.0', formattedValue: '31.0%' },
          { path: 'src/cart.ts', value: '45.2', formattedValue: '45.2%' },
        ],
      });

      // The page already covered every matching file (fetchedCount === totalCount), so there's
      // no "N more" hint to show, even though entries.length (2) is less than totalCount (3).
      const tableResult = await harness.run(
        `quality-gate status --project my-project --format table`,
      );
      expect(tableResult.stdout).not.toContain('more');
      expect(tableResult.stdout).not.toContain('--top');
    },
    { timeout: 15000 },
  );
  it(
    'shows a "N more" hint with a --top suggestion when the table omits entries the JSON totalCount accounts for',
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
              { path: 'src/a.ts', value: '10.0' },
              { path: 'src/b.ts', value: '20.0' },
              { path: 'src/c.ts', value: '30.0' },
              { path: 'src/d.ts', value: '40.0' },
              { path: 'src/e.ts', value: '50.0' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --top 2 --format table`,
      );

      const lines = result.stdout.split('\n');
      const conditionIndex = lines.findIndex((l) => l.includes('Coverage on New Code'));
      expect(lines[conditionIndex + 1]).toContain('src/a.ts');
      expect(lines[conditionIndex + 2]).toContain('src/b.ts');
      expect(lines[conditionIndex + 3]).toContain('… 3 more');
      expect(lines[conditionIndex + 3]).toContain('use --top 5 to display all');
    },
    { timeout: 15000 },
  );
  it(
    'clamps the suggested --top to MAX_PAGE_SIZE and says "to display more" when totalCount exceeds it',
    async () => {
      const manyFiles = Array.from({ length: 501 }, (_, i) => ({
        path: `src/file${i}.ts`,
        value: '10.0',
      }));
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
            .withComponentTreeFiles('new_coverage', manyFiles),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --top 3 --format table`,
      );

      const lines = result.stdout.split('\n');
      const hintLine = lines.find((l) => l.includes('more'));
      expect(hintLine).toContain('… 498 more');
      // 500 (MAX_PAGE_SIZE), not 501 (totalCount) - a suggested --top the command would reject
      // defeats the purpose of the hint.
      expect(hintLine).toContain('use --top 500 to display more');
      expect(hintLine).not.toContain('use --top 501');

      // The suggested --top must actually be runnable, not just look like a number.
      const followUp = await harness.run(
        `quality-gate status --project my-project --top 500 --format table`,
      );
      expect(followUp.exitCode).not.toBe(2);

      // Having followed the suggestion, --top is now at MAX_PAGE_SIZE - raising it further
      // wouldn't reveal the last remaining file, so the hint must stop suggesting a --top value
      // instead of repeating the exact command the user just ran.
      const followUpHintLine = followUp.stdout.split('\n').find((l) => l.includes('more'));
      expect(followUpHintLine).toContain('… 1 more');
      expect(followUpHintLine).toContain('capped at 500 results per fetch');
      expect(followUpHintLine).not.toContain('--top');
    },
    { timeout: 15000 },
  );
  it(
    'omits the "N more" hint when the table already shows every entry',
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

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      expect(result.stdout).not.toContain('more');
      expect(result.stdout).not.toContain('--top');
    },
    { timeout: 15000 },
  );
  it(
    'omits the breakdown entirely when no failing condition matches an implemented category',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('ERROR').withConditions([
            {
              status: 'ERROR',
              metricKey: 'new_violations',
              comparator: 'GT',
              errorThreshold: '0',
              actualValue: '3',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.conditions[0].breakdown).toBeUndefined();
      const componentTreeRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/measures/component_tree');
      expect(componentTreeRequests).toHaveLength(0);
    },
    { timeout: 15000 },
  );
  it(
    'does not fetch a breakdown at all when the quality gate passes',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      await harness.run(`quality-gate status --project my-project`);

      const componentTreeRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/measures/component_tree');
      expect(componentTreeRequests).toHaveLength(0);
    },
    { timeout: 15000 },
  );
  it(
    'still reports the real verdict and exit code when the breakdown fetch itself fails',
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
            .withComponentTreeError(500),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.status).toBe('ERROR');
      expect(parsed.qualityGate.conditions[0].breakdown).toBeUndefined();
    },
    { timeout: 15000 },
  );
  it(
    "keeps a sibling condition's breakdown when only one condition's fetch fails",
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          { key: 'coverage', type: 'PERCENT', name: 'Coverage' },
          { key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' },
        ])
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
              {
                status: 'ERROR',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '55.0',
              },
            ])
            .withComponentTreeErrorForMetric('coverage', 500)
            .withComponentTreeFiles('new_coverage', [{ path: 'src/checkout.ts', value: '31.0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const coverageCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'coverage',
      );
      const newCoverageCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_coverage',
      );
      expect(coverageCondition.breakdown).toBeUndefined();
      expect(newCoverageCondition.breakdown).toEqual({
        totalCount: 1,
        fetchedCount: 1,
        entries: [{ path: 'src/checkout.ts', value: '31.0', formattedValue: '31.0%' }],
      });
    },
    { timeout: 15000 },
  );
  it(
    'includes an entry for every matching condition, in condition order, when several fetch concurrently',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          { key: 'coverage', type: 'PERCENT', name: 'Coverage' },
          { key: 'branch_coverage', type: 'PERCENT', name: 'Condition Coverage' },
          { key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' },
        ])
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
              {
                status: 'ERROR',
                metricKey: 'branch_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '50.0',
              },
              {
                status: 'ERROR',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '55.0',
              },
            ])
            .withComponentTreeFiles('coverage', [{ path: 'src/checkout.ts', value: '31.0' }])
            .withComponentTreeFiles('branch_coverage', [{ path: 'src/cart.ts', value: '40.0' }])
            .withComponentTreeFiles('new_coverage', [{ path: 'src/pay.ts', value: '55.0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.conditions).toEqual([
        expect.objectContaining({
          metric: 'coverage',
          breakdown: {
            totalCount: 1,
            fetchedCount: 1,
            entries: [{ path: 'src/checkout.ts', value: '31.0', formattedValue: '31.0%' }],
          },
        }),
        expect.objectContaining({
          metric: 'branch_coverage',
          breakdown: {
            totalCount: 1,
            fetchedCount: 1,
            entries: [{ path: 'src/cart.ts', value: '40.0', formattedValue: '40.0%' }],
          },
        }),
        expect.objectContaining({
          metric: 'new_coverage',
          breakdown: {
            totalCount: 1,
            fetchedCount: 1,
            entries: [{ path: 'src/pay.ts', value: '55.0', formattedValue: '55.0%' }],
          },
        }),
      ]);
    },
    { timeout: 15000 },
  );
  it(
    'passes --top through to the component_tree request',
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
            .withComponentTreeFiles('new_coverage', [{ path: 'src/checkout.ts', value: '31.0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      await harness.run(`quality-gate status --project my-project --top 7`);

      const componentTreeRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/measures/component_tree');
      expect(componentTreeRequests).toHaveLength(1);
      expect(componentTreeRequests[0].query.ps).toBe('7');
    },
    { timeout: 15000 },
  );
  it(
    'requests the default --top of 500 files when --top is not given',
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
            .withComponentTreeFiles('new_coverage', [{ path: 'src/checkout.ts', value: '31.0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      await harness.run(`quality-gate status --project my-project`);

      const componentTreeRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/measures/component_tree');
      expect(componentTreeRequests).toHaveLength(1);
      expect(componentTreeRequests[0].query.ps).toBe('500');
    },
    { timeout: 15000 },
  );
  it(
    'omits the breakdown and warns on stderr for a non-coverage condition even when --category coverage is given',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('ERROR').withConditions([
            {
              status: 'ERROR',
              metricKey: 'new_violations',
              comparator: 'GT',
              errorThreshold: '0',
              actualValue: '3',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --category coverage --format json`,
      );

      // stdout must stay valid JSON even though a warning was also emitted, on stderr.
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.conditions.length).toBeGreaterThan(0);
      expect(
        parsed.qualityGate.conditions.every(
          (c: { breakdown?: unknown }) => c.breakdown === undefined,
        ),
      ).toBe(true);
      expect(result.stderr).toContain("No failing conditions match category 'coverage'");
      const componentTreeRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/measures/component_tree');
      expect(componentTreeRequests).toHaveLength(0);
    },
    { timeout: 15000 },
  );
  it(
    'does not warn when --category matches a failing condition, even if enrichment finds no files',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' }])
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

      const result = await harness.run(
        `quality-gate status --project my-project --category coverage --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      expect(
        parsed.qualityGate.conditions.every(
          (c: { breakdown?: unknown }) => c.breakdown === undefined,
        ),
      ).toBe(true);
      expect(result.stderr).not.toContain('No failing conditions match category');
    },
    { timeout: 15000 },
  );
  it(
    'does not warn about an unmatched --category when the quality gate passed entirely',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('OK').withConditions([
            {
              status: 'OK',
              metricKey: 'new_violations',
              comparator: 'GT',
              errorThreshold: '0',
              actualValue: '0',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --category coverage --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      expect(
        parsed.qualityGate.conditions.every(
          (c: { breakdown?: unknown }) => c.breakdown === undefined,
        ),
      ).toBe(true);
      expect(result.stderr).not.toContain('No failing conditions match category');
    },
    { timeout: 15000 },
  );
  it(
    'does not warn about an unmatched --category when the project has no quality gate status yet',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --category coverage --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      expect(
        parsed.qualityGate.conditions.every(
          (c: { breakdown?: unknown }) => c.breakdown === undefined,
        ),
      ).toBe(true);
      expect(result.stderr).not.toContain('No failing conditions match category');
    },
    { timeout: 15000 },
  );
  it(
    'only enriches the coverage condition when multiple conditions fail together',
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
                metricKey: 'new_violations',
                comparator: 'GT',
                errorThreshold: '0',
                actualValue: '3',
              },
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

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const violationsCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_violations',
      );
      const coverageCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_coverage',
      );
      expect(violationsCondition.breakdown).toBeUndefined();
      expect(coverageCondition.breakdown).toEqual({
        totalCount: 1,
        fetchedCount: 1,
        entries: [{ path: 'src/checkout.ts', value: '31.0', formattedValue: '31.0%' }],
      });
      const componentTreeRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/measures/component_tree');
      expect(componentTreeRequests).toHaveLength(1);
    },
    { timeout: 15000 },
  );
  it(
    'attaches the breakdown to the correct condition in the table when multiple conditions fail',
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
                metricKey: 'new_violations',
                comparator: 'GT',
                errorThreshold: '0',
                actualValue: '3',
              },
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

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      const lines = result.stdout.split('\n');
      const violationsIndex = lines.findIndex((l) => l.includes('new_violations'));
      const coverageIndex = lines.findIndex((l) => l.includes('new_coverage'));
      const fileIndex = lines.findIndex((l) => l.includes('src/checkout.ts'));

      expect(violationsIndex).toBeGreaterThanOrEqual(0);
      expect(coverageIndex).toBeGreaterThan(violationsIndex);
      // The breakdown line must sit directly after the coverage condition's own line - proving
      // it's attached to that condition specifically, not bleeding onto new_violations above it.
      expect(fileIndex).toBe(coverageIndex + 1);
    },
    { timeout: 15000 },
  );
  it(
    'does not enrich a passing coverage condition even when --all is given',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('ERROR').withConditions([
            {
              status: 'OK',
              metricKey: 'new_coverage',
              comparator: 'LT',
              errorThreshold: '80',
              actualValue: '95.0',
            },
            {
              status: 'ERROR',
              metricKey: 'new_violations',
              comparator: 'GT',
              errorThreshold: '0',
              actualValue: '3',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --all --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.conditions).toHaveLength(2);
      expect(
        parsed.qualityGate.conditions.every(
          (c: { breakdown?: unknown }) => c.breakdown === undefined,
        ),
      ).toBe(true);
      const componentTreeRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/measures/component_tree');
      expect(componentTreeRequests).toHaveLength(0);
    },
    { timeout: 15000 },
  );
  it(
    'rejects an invalid --category value, before making any network call',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --category security`,
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "Invalid --category option: 'security'. Must be one of: coverage",
      );
      const statusRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/qualitygates/project_status');
      expect(statusRequests).toHaveLength(0);
    },
    { timeout: 15000 },
  );
  it(
    'rejects a non-numeric --top value',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --top abc`);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Not a number');
    },
    { timeout: 15000 },
  );
  it(
    'rejects a --top value below 1, before making any network call',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --top 0`);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "Invalid --top option: '0'. Must be an integer between 1 and 500",
      );
      const statusRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/qualitygates/project_status');
      expect(statusRequests).toHaveLength(0);
    },
    { timeout: 15000 },
  );
  it(
    'rejects a --top value above 500',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --top 501`);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "Invalid --top option: '501'. Must be an integer between 1 and 500",
      );
    },
    { timeout: 15000 },
  );
});
