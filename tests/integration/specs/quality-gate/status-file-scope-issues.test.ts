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

// Integration tests for `quality-gate status <file>` - issues/reliability/maintainability/
// security conditions, evaluated against the resolved file/directory's own value (via
// measures/component), with the actual matching issues shown as a supporting breakdown.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('quality-gate status <file> — issues/security', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'reports a failing issues condition for a single file, with the actual matching issues',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_violations', type: 'INT', name: 'New Issues' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('OK')
            .withConditions([
              { status: 'OK', metricKey: 'new_violations', comparator: 'GT', errorThreshold: '0' },
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
        `quality-gate status src/checkout.ts --project my-project --format json`,
      );

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_violations',
      );
      expect(condition.status).toBe('ERROR');
      expect(condition.actualValue).toBe('1');
      expect(condition.breakdown).toEqual({
        category: 'issues',
        totalCount: 1,
        fetchedCount: 1,
        entries: [
          {
            file: 'src/checkout.ts',
            line: 17,
            key: 'ISSUE-1',
            rule: 'typescript:S1854',
            message: "Dead assignment to 'total'",
          },
        ],
      });

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.components).toBe('my-project:src/checkout.ts');
    },
    { timeout: 15000 },
  );

  it(
    'reports a failing security condition for a file, filtered to VULNERABILITY',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'vulnerabilities', type: 'INT', name: 'Vulnerabilities' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('OK')
            .withConditions([
              { status: 'OK', metricKey: 'vulnerabilities', comparator: 'GT', errorThreshold: '0' },
            ])
            .withComponentsTreeItems([{ path: 'src/exec.ts', qualifier: 'FIL' }])
            .withComponentMeasures('src/exec.ts', [{ metric: 'vulnerabilities', value: '1' }])
            .withIssue({
              key: 'VULN-1',
              ruleKey: 'java:S2076',
              message: 'OS command injection',
              component: 'my-project:src/exec.ts',
              type: 'VULNERABILITY',
            })
            .withIssue({
              key: 'SMELL-1',
              ruleKey: 'java:S100',
              message: 'Rename this',
              component: 'my-project:src/exec.ts',
              type: 'CODE_SMELL',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/exec.ts --project my-project --format json`,
      );

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'vulnerabilities',
      );
      expect(condition.breakdown.category).toBe('security');
      expect(condition.breakdown.entries).toHaveLength(1);
      expect(condition.breakdown.entries[0].key).toBe('VULN-1');

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.types).toBe('VULNERABILITY');
    },
    { timeout: 15000 },
  );

  it(
    'formats a RATING condition value as a letter grade, not the raw decimal measures/component sends',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'security_rating', type: 'RATING', name: 'Security Rating' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('OK')
            .withConditions([
              { status: 'OK', metricKey: 'security_rating', comparator: 'GT', errorThreshold: '1' },
            ])
            .withComponentsTreeItems([{ path: 'src/exec.ts', qualifier: 'FIL' }])
            // measures/component sends ratings as "1.0", unlike project_status's bare "1"
            .withComponentMeasures('src/exec.ts', [{ metric: 'security_rating', value: '1.0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/exec.ts --project my-project --all --format json`,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'security_rating',
      );
      expect(condition.actualValue).toBe('1.0');
      expect(condition.formattedActualValue).toBe('A');
    },
    { timeout: 15000 },
  );

  it(
    'a passing issues condition under --all has no breakdown attached',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_violations', type: 'INT', name: 'New Issues' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('OK')
            .withConditions([
              { status: 'OK', metricKey: 'new_violations', comparator: 'GT', errorThreshold: '0' },
            ])
            .withComponentsTreeItems([{ path: 'src/clean.ts', qualifier: 'FIL' }])
            .withComponentMeasures('src/clean.ts', [{ metric: 'new_violations', value: '0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/clean.ts --project my-project --format json --all`,
      );

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_violations',
      );
      expect(condition.status).toBe('OK');
      expect(condition.breakdown).toBeUndefined();

      const recorded = server.getRecordedRequests();
      expect(recorded.some((r) => r.path === '/api/issues/search')).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'scopes the issues search to a directory component key, showing issues directly within it',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_violations', type: 'INT', name: 'New Issues' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('OK')
            .withConditions([
              { status: 'OK', metricKey: 'new_violations', comparator: 'GT', errorThreshold: '0' },
            ])
            .withComponentsTreeItems([{ path: 'src/checkout', qualifier: 'DIR' }])
            .withComponentMeasures('src/checkout', [{ metric: 'new_violations', value: '1' }])
            .withIssue({
              key: 'ISSUE-1',
              ruleKey: 'typescript:S1854',
              message: "Dead assignment to 'total'",
              component: 'my-project:src/checkout/cart.ts',
              isNewCode: true,
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status src/checkout --project my-project --format json`,
      );

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_violations',
      );
      expect(condition.breakdown.entries).toHaveLength(1);
      expect(condition.breakdown.entries[0].file).toBe('src/checkout/cart.ts');

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.components).toBe('my-project:src/checkout');
    },
    { timeout: 15000 },
  );

  it(
    'renders the issues breakdown in the table as flat file:line/key/rule/message rows',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_violations', type: 'INT', name: 'New Issues' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('OK')
            .withConditions([
              { status: 'OK', metricKey: 'new_violations', comparator: 'GT', errorThreshold: '0' },
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
        `quality-gate status src/checkout.ts --project my-project --format table`,
      );

      const line = result.stdout.split('\n').find((l) => l.includes('ISSUE-1'));
      expect(line).toContain('src/checkout.ts:17');
      expect(line).toContain('typescript:S1854');
      expect(line).toContain("Dead assignment to 'total'");
    },
    { timeout: 15000 },
  );
});
