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

// --category only gates breakdown attachment, never hides a condition. Uses issues + security,
// since coverage/duplications are directory-only and never attach at file level either way.

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
        `quality-gate status src/checkout.ts --project my-project --category duplications --format json`,
      );

      expect(result.exitCode).toBe(51);
      expect(result.stderr).toContain("No failing conditions match category 'duplications'.");
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
});
