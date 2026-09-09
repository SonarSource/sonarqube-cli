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

// Integration tests for the dependency-risks category breakdown in `quality-gate status`

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('quality-gate status — dependency-risks breakdown', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'includes a flat, multi-type breakdown in JSON for a failing any_issue count condition',
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
                actualValue: '2',
              },
            ])
            .withDependencyRisks([
              {
                key: 'RISK-1',
                packageName: 'event-stream',
                version: '3.3.6',
                severity: 'BLOCKER',
                type: 'MALWARE',
                newlyIntroduced: true,
              },
              {
                key: 'RISK-2',
                packageName: 'lodash',
                version: '4.17.20',
                severity: 'HIGH',
                type: 'VULNERABILITY',
                vulnerabilityId: 'CVE-2021-23337',
                newlyIntroduced: true,
              },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      expect(result.exitCode).toBe(51);
      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_sca_count_any_issue',
      );
      expect(condition.breakdown).toEqual({
        category: 'dependency-risks',
        totalCount: 2,
        fetchedCount: 2,
        entries: [
          {
            package: 'event-stream',
            version: '3.3.6',
            severity: 'BLOCKER',
            type: 'MALWARE',
            key: 'RISK-1',
          },
          {
            package: 'lodash',
            version: '4.17.20',
            severity: 'HIGH',
            type: 'VULNERABILITY',
            key: 'RISK-2',
            vulnerabilityId: 'CVE-2021-23337',
          },
        ],
      });
    },
    { timeout: 15000 },
  );

  it(
    'restricts to a single risk type for a failing vulnerability-only condition',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'sca_severity_vulnerability',
            type: 'INT',
            name: 'Severity of a vulnerability dependency risk',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'sca_severity_vulnerability',
                comparator: 'GT',
                errorThreshold: '14',
                actualValue: '15',
              },
            ])
            .withDependencyRisks([
              {
                packageName: 'axios',
                version: '0.21.1',
                severity: 'MEDIUM',
                type: 'VULNERABILITY',
              },
              // A licensing risk must never show up under a vulnerability-only condition.
              {
                packageName: 'left-pad',
                version: '1.0.0',
                severity: 'HIGH',
                type: 'PROHIBITED_LICENSE',
              },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'sca_severity_vulnerability',
      );
      expect(condition.breakdown.entries).toHaveLength(1);
      expect(condition.breakdown.entries[0].package).toBe('axios');
    },
    { timeout: 15000 },
  );

  it(
    'includes a dependency-risks breakdown for a failing rating condition',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'sca_rating_licensing',
            type: 'RATING',
            name: 'Dependency risk rating for licenses',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'sca_rating_licensing',
                comparator: 'GT',
                errorThreshold: '1',
                actualValue: '4',
              },
            ])
            .withDependencyRisks([
              {
                packageName: 'gpl-lib',
                version: '2.0.0',
                severity: 'HIGH',
                type: 'PROHIBITED_LICENSE',
              },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'sca_rating_licensing',
      );
      expect(condition.formattedActualValue).toBe('D');
      expect(condition.breakdown).toEqual({
        category: 'dependency-risks',
        totalCount: 1,
        fetchedCount: 1,
        entries: [
          {
            package: 'gpl-lib',
            version: '2.0.0',
            severity: 'HIGH',
            type: 'PROHIBITED_LICENSE',
            key: 'RISK-1',
          },
        ],
      });
    },
    { timeout: 15000 },
  );

  it(
    'excludes an already-fixed risk - the breakdown must match what the condition itself counted',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'sca_count_malware', type: 'INT', name: 'Count of malware risks' }])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'sca_count_malware',
                comparator: 'GT',
                errorThreshold: '0',
                actualValue: '1',
              },
            ])
            .withDependencyRisks([
              { packageName: 'evil-pkg', version: '1.0.0', severity: 'BLOCKER', type: 'MALWARE' },
              {
                packageName: 'already-fixed-pkg',
                version: '2.0.0',
                severity: 'BLOCKER',
                type: 'MALWARE',
                status: 'FIXED',
              },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'sca_count_malware',
      );
      expect(condition.breakdown.entries).toHaveLength(1);
      expect(condition.breakdown.entries[0].package).toBe('evil-pkg');
    },
    { timeout: 15000 },
  );

  it(
    'renders package@version, severity, type and the CVE in the table',
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
                actualValue: '2',
              },
            ])
            .withDependencyRisks([
              {
                packageName: 'event-stream',
                version: '3.3.6',
                severity: 'BLOCKER',
                type: 'MALWARE',
                newlyIntroduced: true,
              },
              {
                packageName: 'lodash',
                version: '4.17.20',
                severity: 'HIGH',
                type: 'VULNERABILITY',
                vulnerabilityId: 'CVE-2021-23337',
                newlyIntroduced: true,
              },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      const lines = result.stdout.split('\n');
      const conditionIndex = lines.findIndex((l) => l.includes('Count of new dependency risks'));
      expect(lines[conditionIndex + 1]).toContain('event-stream@3.3.6');
      expect(lines[conditionIndex + 1]).toContain('BLOCKER');
      expect(lines[conditionIndex + 1]).toContain('MALWARE');
      expect(lines[conditionIndex + 2]).toContain('lodash@4.17.20');
      expect(lines[conditionIndex + 2]).toContain('HIGH');
      expect(lines[conditionIndex + 2]).toContain('VULNERABILITY');
      expect(lines[conditionIndex + 2]).toContain('CVE-2021-23337');
    },
    { timeout: 15000 },
  );

  it(
    'includes the dependency-risks breakdown when --category dependency-risks is passed explicitly',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          { key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' },
          { key: 'new_sca_count_any_issue', type: 'INT', name: 'Count of new dependency risks' },
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
                actualValue: '50',
              },
              {
                status: 'ERROR',
                metricKey: 'new_sca_count_any_issue',
                comparator: 'GT',
                errorThreshold: '0',
                actualValue: '1',
              },
            ])
            .withDependencyRisks([
              {
                packageName: 'event-stream',
                version: '3.3.6',
                severity: 'BLOCKER',
                type: 'MALWARE',
                newlyIntroduced: true,
              },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --category dependency-risks --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      const coverageCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_coverage',
      );
      const riskCondition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'new_sca_count_any_issue',
      );
      expect(coverageCondition.breakdown).toBeUndefined();
      expect(riskCondition.breakdown.category).toBe('dependency-risks');
    },
    { timeout: 15000 },
  );

  it(
    'caps entries at --top and reports the remaining count',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'sca_count_vulnerability',
            type: 'INT',
            name: 'Count of vulnerability dependency risks',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'sca_count_vulnerability',
                comparator: 'GT',
                errorThreshold: '0',
                actualValue: '3',
              },
            ])
            .withDependencyRisks([
              { packageName: 'pkg-a', version: '1.0.0', severity: 'HIGH', type: 'VULNERABILITY' },
              { packageName: 'pkg-b', version: '1.0.0', severity: 'MEDIUM', type: 'VULNERABILITY' },
              { packageName: 'pkg-c', version: '1.0.0', severity: 'LOW', type: 'VULNERABILITY' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --top 2 --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'sca_count_vulnerability',
      );
      expect(condition.breakdown.totalCount).toBe(3);
      expect(condition.breakdown.fetchedCount).toBe(2);
      expect(condition.breakdown.entries).toHaveLength(2);
    },
    { timeout: 15000 },
  );

  it(
    'sorts entries worst-first by severity regardless of configuration order',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'sca_count_vulnerability',
            type: 'INT',
            name: 'Count of vulnerability dependency risks',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'sca_count_vulnerability',
                comparator: 'GT',
                errorThreshold: '0',
                actualValue: '3',
              },
            ])
            .withDependencyRisks([
              { packageName: 'pkg-low', version: '1.0.0', severity: 'LOW', type: 'VULNERABILITY' },
              {
                packageName: 'pkg-blocker',
                version: '1.0.0',
                severity: 'BLOCKER',
                type: 'VULNERABILITY',
              },
              {
                packageName: 'pkg-medium',
                version: '1.0.0',
                severity: 'MEDIUM',
                type: 'VULNERABILITY',
              },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `quality-gate status --project my-project --top 2 --format json`,
      );

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'sca_count_vulnerability',
      );
      expect(condition.breakdown.entries.map((e: { package: string }) => e.package)).toEqual([
        'pkg-blocker',
        'pkg-medium',
      ]);
    },
    { timeout: 15000 },
  );

  it(
    'excludes risks with an unrecognized severity from fetchedCount',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'sca_count_vulnerability',
            type: 'INT',
            name: 'Count of vulnerability dependency risks',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'sca_count_vulnerability',
                comparator: 'GT',
                errorThreshold: '0',
                actualValue: '2',
              },
            ])
            .withDependencyRisks([
              { packageName: 'pkg-a', version: '1.0.0', severity: 'HIGH', type: 'VULNERABILITY' },
              {
                packageName: 'pkg-b',
                version: '1.0.0',
                severity: 'CRITICAL',
                type: 'VULNERABILITY',
              },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format json`);

      const parsed = JSON.parse(result.stdout);
      const condition = parsed.qualityGate.conditions.find(
        (c: { metric: string }) => c.metric === 'sca_count_vulnerability',
      );
      expect(condition.breakdown.entries).toHaveLength(1);
      expect(condition.breakdown.fetchedCount).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'forwards the organization query param on a cloud connection',
    async () => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('test-token')
        .withMetrics([
          {
            key: 'sca_count_vulnerability',
            type: 'INT',
            name: 'Count of vulnerability dependency risks',
          },
        ])
        .withProject('my-project', (p) =>
          p
            .withProjectStatus('ERROR')
            .withConditions([
              {
                status: 'ERROR',
                metricKey: 'sca_count_vulnerability',
                comparator: 'GT',
                errorThreshold: '0',
                actualValue: '1',
              },
            ])
            .withDependencyRisks([
              { packageName: 'pkg-a', version: '1.0.0', severity: 'HIGH', type: 'VULNERABILITY' },
            ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

      await harness.run(`quality-gate status --project my-project --format json`);

      const scaRequest = server
        .getRecordedRequests()
        .find((r) => r.path === '/sca/issues-releases');
      expect(scaRequest?.query.organization).toBe('my-org');
    },
    { timeout: 15000 },
  );
});
