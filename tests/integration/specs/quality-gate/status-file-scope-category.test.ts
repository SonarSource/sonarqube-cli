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

// --category only gates breakdown attachment, never hides a condition. Also covers the
// "category not drillable at this scope" warning, distinct from "no failing condition
// matches this category" - see CATEGORY_METRICS/FILE_SCOPED_CATEGORIES in breakdown.ts and
// file-scope-conditions.ts.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('quality-gate status <file> — --category', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    '--category issues attaches the breakdown only to the issues condition, not the security one',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          { key: 'new_violations', type: 'INT', name: 'New Issues' },
          { key: 'vulnerabilities', type: 'INT', name: 'Vulnerabilities' },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_violations',
                comparator: 'GT',
                errorThreshold: '0',
              },
              {
                status: 'ERROR',
                metricKey: 'vulnerabilities',
                comparator: 'GT',
                errorThreshold: '0',
              },
            ])
            .withComponentsTreeItems([{ path: 'src/checkout.ts', qualifier: 'FIL' }])
            .withComponentMeasures('src/checkout.ts', [
              { metric: 'new_violations', value: '1' },
              { metric: 'vulnerabilities', value: '1' },
            ])
            .withIssue({
              key: 'ISSUE-1',
              ruleKey: 'typescript:S1854',
              message: "Dead assignment to 'total'",
              component: 'my-project:src/checkout.ts',
              line: 17,
              isNewCode: true,
            })
            .withIssue({
              key: 'VULN-1',
              ruleKey: 'java:S2076',
              message: 'OS command injection',
              component: 'my-project:src/checkout.ts',
              type: 'VULNERABILITY',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/checkout.ts --project my-project --category issues --format json`,
      );

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const issues = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_violations',
      );
      const security = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'vulnerabilities',
      );
      expect(issues.breakdown).toBeDefined();
      expect(issues.breakdown.category).toBe('issues');
      expect(security.status).toBe('ERROR');
      expect(security.breakdown).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'warns on stderr, without hiding either condition, when --category matches no failing condition',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          { key: 'new_violations', type: 'INT', name: 'New Issues' },
          { key: 'vulnerabilities', type: 'INT', name: 'Vulnerabilities' },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_violations',
                comparator: 'GT',
                errorThreshold: '0',
              },
              {
                status: 'OK',
                metricKey: 'vulnerabilities',
                comparator: 'GT',
                errorThreshold: '0',
              },
            ])
            .withComponentsTreeItems([{ path: 'src/checkout.ts', qualifier: 'FIL' }])
            .withComponentMeasures('src/checkout.ts', [
              { metric: 'new_violations', value: '1' },
              { metric: 'vulnerabilities', value: '0' },
            ])
            .withIssue({
              key: 'ISSUE-1',
              ruleKey: 'typescript:S1854',
              message: "Dead assignment to 'total'",
              component: 'my-project:src/checkout.ts',
              line: 17,
              isNewCode: true,
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/checkout.ts --project my-project --category security --format json --all`,
      );

      expect(result.exitCode).toBe(51);
      expect(result.stderr).toContain("No failing conditions match category 'security'.");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.conditions).toHaveLength(2);
      expect(
        parsed.qualityGate.conditions.every(
          (c: { breakdown?: unknown }) => c.breakdown === undefined,
        ),
      ).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'warns that the category has no file-level breakdown, rather than claiming no failing condition matches it, for a directory-only category requested on a file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_violations', type: 'INT', name: 'New Issues' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_violations',
                comparator: 'GT',
                errorThreshold: '0',
              },
            ])
            .withComponentsTreeItems([{ path: 'src/checkout.ts', qualifier: 'FIL' }])
            .withComponentMeasures('src/checkout.ts', [{ metric: 'new_violations', value: '1' }])
            .withIssue({
              key: 'ISSUE-1',
              ruleKey: 'typescript:S1854',
              message: "Dead assignment to 'total'",
              component: 'my-project:src/checkout.ts',
              line: 17,
              isNewCode: true,
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/checkout.ts --project my-project --category duplications --format json`,
      );

      expect(result.exitCode).toBe(51);
      expect(result.stderr).toContain(
        "Category 'duplications' has no file-level breakdown; showing conditions only.",
      );
      expect(result.stderr).not.toContain('No failing conditions match');
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.conditions).toHaveLength(1);
      expect(parsed.qualityGate.conditions[0].breakdown).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'warns that the category has no file-level breakdown for dependency-risks, which is never drillable at file/directory scope',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          { key: 'new_violations', type: 'INT', name: 'New Issues' },
          { key: 'new_sca_count_any_issue', type: 'INT', name: 'Count of new dependency risks' },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_violations',
                comparator: 'GT',
                errorThreshold: '0',
              },
              {
                status: 'ERROR',
                metricKey: 'new_sca_count_any_issue',
                comparator: 'GT',
                errorThreshold: '0',
              },
            ])
            .withComponentsTreeItems([{ path: 'src/checkout.ts', qualifier: 'FIL' }])
            .withComponentMeasures('src/checkout.ts', [{ metric: 'new_violations', value: '1' }])
            .withIssue({
              key: 'ISSUE-1',
              ruleKey: 'typescript:S1854',
              message: "Dead assignment to 'total'",
              component: 'my-project:src/checkout.ts',
              line: 17,
              isNewCode: true,
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/checkout.ts --project my-project --category dependency-risks --format json`,
      );

      expect(result.exitCode).toBe(51);
      expect(result.stderr).toContain(
        "Category 'dependency-risks' has no file-level breakdown; showing conditions only.",
      );
      expect(result.stderr).not.toContain('No failing conditions match');
    },
    { timeout: 15000 },
  );

  it(
    'does not warn about drillability for a directory whose gate has no file-scoped conditions at all',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          { key: 'new_sca_count_any_issue', type: 'INT', name: 'Count of new dependency risks' },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'new_sca_count_any_issue',
                comparator: 'GT',
                errorThreshold: '0',
              },
            ])
            .withComponentsTreeItems([{ path: 'src/checkout', qualifier: 'DIR' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/checkout --project my-project --category coverage --format json`,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('has no');
      expect(result.stderr).not.toContain('No failing conditions match');
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.status).toBe('NOT_APPLICABLE');
      expect(parsed.qualityGate.conditions).toEqual([]);
    },
    { timeout: 15000 },
  );
});
