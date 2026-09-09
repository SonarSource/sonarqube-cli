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

// Integration tests for the issues category breakdown (Issues, Reliability and Maintainability
// domains, all folded into `--category issues`) in `quality-gate status`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('quality-gate status — issues breakdown', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'includes an issues breakdown in JSON for a failing overall violations condition, unfiltered by type',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              { status: 'ERROR', metricKey: 'violations', comparator: 'GT', errorThreshold: '0' },
            ])
            .withIssue({
              key: 'ISSUE-1',
              ruleKey: 'java:S1234',
              message: 'Fix this bug',
              component: 'my-project:src/checkout.ts',
              line: 12,
              type: 'BUG',
            })
            .withIssue({
              key: 'ISSUE-2',
              ruleKey: 'java:S5678',
              message: 'Simplify this',
              component: 'my-project:src/cart.ts',
              line: 3,
              type: 'CODE_SMELL',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'violations',
      );
      expect(condition.breakdown).toEqual({
        category: 'issues',
        totalCount: 2,
        fetchedCount: 2,
        entries: [
          {
            file: 'src/checkout.ts',
            line: 12,
            key: 'ISSUE-1',
            rule: 'java:S1234',
            message: 'Fix this bug',
          },
          {
            file: 'src/cart.ts',
            line: 3,
            key: 'ISSUE-2',
            rule: 'java:S5678',
            message: 'Simplify this',
          },
        ],
      });

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.types).toBeUndefined();
      expect(req?.query.resolved).toBe('false');
      expect(req?.query.inNewCodePeriod).toBeUndefined();
      expect(req?.query.s).toBe('SEVERITY');
      expect(req?.query.asc).toBe('false');
    },
    { timeout: 15000 },
  );

  it(
    'adds inNewCodePeriod=true for a failing new_violations condition',
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
              },
            ])
            .withIssue({
              key: 'ISSUE-1',
              ruleKey: 'java:S1234',
              message: 'New issue',
              component: 'my-project:src/checkout.ts',
              isNewCode: true,
            })
            .withIssue({
              key: 'ISSUE-2',
              ruleKey: 'java:S5678',
              message: 'Old issue',
              component: 'my-project:src/cart.ts',
              isNewCode: false,
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_violations',
      );
      expect(condition.breakdown.entries).toHaveLength(1);
      expect(condition.breakdown.entries[0].key).toBe('ISSUE-1');

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.inNewCodePeriod).toBe('true');
    },
    { timeout: 15000 },
  );

  it(
    'requests types=BUG for a failing bugs condition',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              { status: 'ERROR', metricKey: 'bugs', comparator: 'GT', errorThreshold: '0' },
            ])
            .withIssue({
              key: 'BUG-1',
              ruleKey: 'java:S2189',
              message: 'Reliability issue',
              component: 'my-project:src/worker.ts',
              type: 'BUG',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'bugs',
      );
      expect(condition.breakdown.entries).toEqual([
        {
          file: 'src/worker.ts',
          line: 1,
          key: 'BUG-1',
          rule: 'java:S2189',
          message: 'Reliability issue',
        },
      ]);

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.types).toBe('BUG');
    },
    { timeout: 15000 },
  );

  it(
    'requests types=BUG and returns the driving issue for a failing reliability_rating condition',
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
                metricKey: 'reliability_rating',
                comparator: 'GT',
                errorThreshold: '1',
                actualValue: '3',
              },
            ])
            .withIssue({
              key: 'BUG-1',
              ruleKey: 'java:S2189',
              message: 'Blocker bug driving the rating',
              component: 'my-project:src/worker.ts',
              severity: 'BLOCKER',
              type: 'BUG',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'reliability_rating',
      );
      expect(condition.breakdown.entries).toHaveLength(1);
      expect(condition.breakdown.entries[0].key).toBe('BUG-1');

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.types).toBe('BUG');
    },
    { timeout: 15000 },
  );

  it(
    'strips the project key prefix from `component` even when the key itself contains colons (Maven-style)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('com.example:my-app', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              { status: 'ERROR', metricKey: 'violations', comparator: 'GT', errorThreshold: '0' },
            ])
            .withIssue({
              key: 'ISSUE-1',
              ruleKey: 'java:S1234',
              message: 'Fix this bug',
              component: 'com.example:my-app:src/main/java/Foo.java',
              line: 10,
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project com.example:my-app --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'violations',
      );
      expect(condition.breakdown.entries[0].file).toBe('src/main/java/Foo.java');
    },
    { timeout: 15000 },
  );

  it(
    'fetches issues once and reuses the result for both members of a redundant metric pair (bugs and reliability_rating)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              { status: 'ERROR', metricKey: 'bugs', comparator: 'GT', errorThreshold: '0' },
              {
                status: 'ERROR',
                metricKey: 'reliability_rating',
                comparator: 'GT',
                errorThreshold: '1',
                actualValue: '3',
              },
            ])
            .withIssue({
              key: 'BUG-1',
              ruleKey: 'java:S2189',
              message: 'Blocker bug',
              component: 'my-project:src/worker.ts',
              type: 'BUG',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const bugsCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'bugs',
      );
      const reliabilityCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'reliability_rating',
      );
      expect(bugsCondition.breakdown.entries).toHaveLength(1);
      expect(reliabilityCondition.breakdown.entries).toHaveLength(1);

      const recorded = server.getRecordedRequests();
      const issuesRequests = recorded.filter((r) => r.path === '/api/issues/search');
      expect(issuesRequests).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'requests types=CODE_SMELL for a failing code_smells condition',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              { status: 'ERROR', metricKey: 'code_smells', comparator: 'GT', errorThreshold: '0' },
            ])
            .withIssue({
              key: 'SMELL-1',
              ruleKey: 'java:S100',
              message: 'Rename this',
              component: 'my-project:src/naming.ts',
              type: 'CODE_SMELL',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      await harness.run(`quality-gate status --project my-project --format json`);

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.types).toBe('CODE_SMELL');
    },
    { timeout: 15000 },
  );

  it(
    'requests types=CODE_SMELL for overall sqale_rating and its new-code equivalent new_maintainability_rating',
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
                metricKey: 'sqale_rating',
                comparator: 'GT',
                errorThreshold: '1',
                actualValue: '3',
              },
              {
                status: 'ERROR',
                metricKey: 'new_maintainability_rating',
                comparator: 'GT',
                errorThreshold: '1',
                actualValue: '2',
              },
            ])
            .withIssue({
              key: 'SMELL-1',
              ruleKey: 'java:S100',
              message: 'Rename this',
              component: 'my-project:src/naming.ts',
              type: 'CODE_SMELL',
              isNewCode: true,
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const sqaleCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'sqale_rating',
      );
      const newRatingCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_maintainability_rating',
      );
      expect(sqaleCondition.breakdown.category).toBe('issues');
      expect(newRatingCondition.breakdown.category).toBe('issues');

      const recorded = server.getRecordedRequests();
      const requests = recorded.filter((r) => r.path === '/api/issues/search');
      expect(requests.every((r) => r.query.types === 'CODE_SMELL')).toBe(true);
      expect(requests.some((r) => r.query.inNewCodePeriod === 'true')).toBe(true);
    },
    { timeout: 15000 },
  );

  it(
    'renders the issues breakdown in the table as flat file:line/key/rule/message rows',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              { status: 'ERROR', metricKey: 'violations', comparator: 'GT', errorThreshold: '0' },
            ])
            .withIssue({
              key: 'ISSUE-1',
              ruleKey: 'java:S1234',
              message: 'Fix this bug',
              component: 'my-project:src/checkout.ts',
              line: 12,
            })
            .withIssue({
              key: 'ISSUE-2',
              ruleKey: 'java:S5678',
              message: 'Simplify this expression',
              component: 'my-project:src/a-very-long-file-name-that-should-not-collide.ts',
              line: 3,
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      const lines = result.stdout.split('\n');
      const firstLine = lines.find((l) => l.includes('ISSUE-1'));
      const secondLine = lines.find((l) => l.includes('ISSUE-2'));
      expect(firstLine).toContain('src/checkout.ts:12');
      expect(firstLine).toContain('java:S1234');
      expect(firstLine).toContain('Fix this bug');
      expect(secondLine).toContain('src/a-very-long-file-name-that-should-not-collide.ts:3');
      expect(secondLine).toContain('java:S5678');
      expect(secondLine).toContain('Simplify this expression');
    },
    { timeout: 15000 },
  );

  it(
    'restricts enrichment to the issues category when --category issues is given, alongside a failing coverage condition',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              { status: 'ERROR', metricKey: 'violations', comparator: 'GT', errorThreshold: '0' },
              {
                status: 'ERROR',
                metricKey: 'new_coverage',
                comparator: 'LT',
                errorThreshold: '80',
                actualValue: '62.4',
              },
            ])
            .withIssue({
              key: 'ISSUE-1',
              ruleKey: 'java:S1234',
              message: 'Fix this bug',
              component: 'my-project:src/checkout.ts',
            })
            .withComponentTreeFiles('new_coverage', [{ path: 'src/checkout.ts', value: '31.0' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --category issues --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      const violationsCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'violations',
      );
      const coverageCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_coverage',
      );
      expect(violationsCondition.breakdown.category).toBe('issues');
      expect(coverageCondition.breakdown).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'passes --top through as ps and reports the total issue count separately from the truncated worst-N entries',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => {
          p.withProjectStatus('ERROR').withConditions([
            { status: 'ERROR', metricKey: 'violations', comparator: 'GT', errorThreshold: '0' },
          ]);
          for (let i = 1; i <= 3; i++) {
            p.withIssue({
              key: `ISSUE-${i}`,
              ruleKey: 'java:S1234',
              message: `Issue ${i}`,
              component: `my-project:src/file${i}.ts`,
            });
          }
          return p;
        })
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --top 2 --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'violations',
      );
      expect(condition.breakdown.totalCount).toBe(3);
      expect(condition.breakdown.fetchedCount).toBe(2);
      expect(condition.breakdown.entries).toHaveLength(2);

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.ps).toBe('2');
    },
    { timeout: 15000 },
  );

  it(
    'still reports the real verdict and exit code when the issues search itself fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              { status: 'ERROR', metricKey: 'violations', comparator: 'GT', errorThreshold: '0' },
            ])
            .withIssuesSearchError(500, 'Internal error'),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'violations',
      );
      expect(condition.breakdown).toBeUndefined();
    },
    { timeout: 15000 },
  );
});
