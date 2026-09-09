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

// Integration tests for the security category breakdown (Security domain only - hotspots are
// out of scope) in `quality-gate status`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('quality-gate status — security breakdown', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'includes an issues-shaped breakdown for a failing overall vulnerabilities condition, filtered to VULNERABILITY',
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
                metricKey: 'vulnerabilities',
                comparator: 'GT',
                errorThreshold: '0',
              },
            ])
            .withIssue({
              key: 'VULN-1',
              ruleKey: 'java:S2076',
              message: 'OS command injection',
              component: 'my-project:src/exec.ts',
              line: 42,
              type: 'VULNERABILITY',
            })
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

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'vulnerabilities',
      );
      expect(condition.breakdown).toEqual({
        category: 'issues',
        totalCount: 1,
        fetchedCount: 1,
        entries: [
          {
            file: 'src/exec.ts',
            line: 42,
            key: 'VULN-1',
            rule: 'java:S2076',
            message: 'OS command injection',
          },
        ],
      });

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.types).toBe('VULNERABILITY');
      expect(req?.query.resolved).toBe('false');
      expect(req?.query.inNewCodePeriod).toBeUndefined();
      expect(req?.query.s).toBe('SEVERITY');
      expect(req?.query.asc).toBe('false');
      expect(recorded.some((r) => r.path === '/api/hotspots/search')).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'adds inNewCodePeriod=true for a failing new_vulnerabilities condition',
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
                metricKey: 'new_vulnerabilities',
                comparator: 'GT',
                errorThreshold: '0',
              },
            ])
            .withIssue({
              key: 'VULN-1',
              ruleKey: 'java:S2076',
              message: 'New vulnerability',
              component: 'my-project:src/exec.ts',
              type: 'VULNERABILITY',
              isNewCode: true,
            })
            .withIssue({
              key: 'VULN-2',
              ruleKey: 'java:S2076',
              message: 'Old vulnerability',
              component: 'my-project:src/legacy.ts',
              type: 'VULNERABILITY',
              isNewCode: false,
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_vulnerabilities',
      );
      expect(condition.breakdown.entries).toHaveLength(1);
      expect(condition.breakdown.entries[0].key).toBe('VULN-1');

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.types).toBe('VULNERABILITY');
      expect(req?.query.inNewCodePeriod).toBe('true');
    },
    { timeout: 15000 },
  );

  it(
    'requests types=VULNERABILITY and returns the driving issue for a failing security_rating condition',
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
                metricKey: 'security_rating',
                comparator: 'GT',
                errorThreshold: '1',
                actualValue: '4',
              },
            ])
            .withIssue({
              key: 'VULN-1',
              ruleKey: 'java:S2076',
              message: 'Blocker vulnerability driving the rating',
              component: 'my-project:src/exec.ts',
              severity: 'BLOCKER',
              type: 'VULNERABILITY',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'security_rating',
      );
      expect(condition.breakdown.entries).toHaveLength(1);
      expect(condition.breakdown.entries[0].key).toBe('VULN-1');

      const recorded = server.getRecordedRequests();
      const req = recorded.find((r) => r.path === '/api/issues/search');
      expect(req?.query.types).toBe('VULNERABILITY');
    },
    { timeout: 15000 },
  );

  it(
    'fetches issues once and reuses the result for both members of a redundant metric pair (vulnerabilities and security_rating)',
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
                metricKey: 'vulnerabilities',
                comparator: 'GT',
                errorThreshold: '0',
              },
              {
                status: 'ERROR',
                metricKey: 'security_rating',
                comparator: 'GT',
                errorThreshold: '1',
                actualValue: '4',
              },
            ])
            .withIssue({
              key: 'VULN-1',
              ruleKey: 'java:S2076',
              message: 'Blocker vulnerability',
              component: 'my-project:src/exec.ts',
              type: 'VULNERABILITY',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const vulnerabilitiesCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'vulnerabilities',
      );
      const ratingCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'security_rating',
      );
      expect(vulnerabilitiesCondition.breakdown.entries).toHaveLength(1);
      expect(ratingCondition.breakdown.entries).toHaveLength(1);

      const recorded = server.getRecordedRequests();
      const issuesRequests = recorded.filter((r) => r.path === '/api/issues/search');
      expect(issuesRequests).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'renders the security breakdown in the table as flat file:line/key/rule/message rows',
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
                metricKey: 'vulnerabilities',
                comparator: 'GT',
                errorThreshold: '0',
              },
            ])
            .withIssue({
              key: 'VULN-1',
              ruleKey: 'java:S2076',
              message: 'OS command injection',
              component: 'my-project:src/exec.ts',
              line: 42,
              type: 'VULNERABILITY',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      const line = result.stdout.split('\n').find((l) => l.includes('VULN-1'));
      expect(line).toContain('src/exec.ts:42');
      expect(line).toContain('java:S2076');
      expect(line).toContain('OS command injection');
    },
    { timeout: 15000 },
  );

  it(
    'restricts enrichment to the security category when --category security is given, alongside a failing issues condition',
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
                metricKey: 'vulnerabilities',
                comparator: 'GT',
                errorThreshold: '0',
              },
              { status: 'ERROR', metricKey: 'violations', comparator: 'GT', errorThreshold: '0' },
            ])
            .withIssue({
              key: 'VULN-1',
              ruleKey: 'java:S2076',
              message: 'OS command injection',
              component: 'my-project:src/exec.ts',
              type: 'VULNERABILITY',
            })
            .withIssue({
              key: 'ISSUE-1',
              ruleKey: 'java:S1234',
              message: 'Fix this bug',
              component: 'my-project:src/checkout.ts',
              type: 'CODE_SMELL',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --category security --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      const vulnerabilitiesCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'vulnerabilities',
      );
      const violationsCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'violations',
      );
      expect(vulnerabilitiesCondition.breakdown.category).toBe('issues');
      expect(violationsCondition.breakdown).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'passes --top through as ps for the security category',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => {
          p.withProjectStatus('ERROR').withConditions([
            {
              status: 'ERROR',
              metricKey: 'vulnerabilities',
              comparator: 'GT',
              errorThreshold: '0',
            },
          ]);
          for (let i = 1; i <= 3; i++) {
            p.withIssue({
              key: `VULN-${i}`,
              ruleKey: 'java:S2076',
              message: `Vulnerability ${i}`,
              component: `my-project:src/file${i}.ts`,
              type: 'VULNERABILITY',
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
        (c: { metric: string }) => c.metric === 'vulnerabilities',
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
              {
                status: 'ERROR',
                metricKey: 'vulnerabilities',
                comparator: 'GT',
                errorThreshold: '0',
              },
            ])
            .withIssuesSearchError(500, 'Internal error'),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'vulnerabilities',
      );
      expect(condition.breakdown).toBeUndefined();
    },
    { timeout: 15000 },
  );
});
