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
      expect(parsed.qualityGate).toEqual({
        status: 'OK',
        project: 'my-project',
        branch: 'main',
        conditions: [],
      });
    },
    { timeout: 15000 },
  );

  it(
    'does not fetch the metric catalog when the gate has no conditions at all',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      await harness.run(`get quality-gate --project my-project`);

      const metricsRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/metrics/search');
      expect(metricsRequests).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'does not fetch the metric catalog when every condition passes and --all is not given',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('OK').withConditions([
            {
              status: 'OK',
              metricKey: 'new_bugs',
              comparator: 'GT',
              errorThreshold: '0',
              actualValue: '0',
            },
            {
              status: 'OK',
              metricKey: 'new_coverage',
              comparator: 'LT',
              errorThreshold: '80',
              actualValue: '95.0',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      await harness.run(`get quality-gate --project my-project`);

      const metricsRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/metrics/search');
      expect(metricsRequests).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'fetches the metric catalog for an all-passing gate when --all is given',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('OK').withConditions([
            {
              status: 'OK',
              metricKey: 'new_bugs',
              comparator: 'GT',
              errorThreshold: '0',
              actualValue: '0',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      await harness.run(`get quality-gate --project my-project --all`);

      const metricsRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/metrics/search');
      expect(metricsRequests).toHaveLength(1);
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
        branch: 'main',
        conditions: [
          {
            status: 'ERROR',
            metric: 'new_coverage',
            metricName: 'new_coverage',
            comparator: 'LT',
            threshold: '80',
            formattedThreshold: '80',
            actualValue: '62.4',
            formattedActualValue: '62.4',
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
          metricName: 'new_coverage',
          comparator: 'LT',
          threshold: '80',
          formattedThreshold: '80',
          actualValue: '62.4',
          formattedActualValue: '62.4',
        },
      ]);
    },
    { timeout: 15000 },
  );

  it(
    'shows passing conditions too when --all is given, failing conditions first',
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

      const result = await harness.run(`get quality-gate --project my-project --all`);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.conditions).toEqual([
        {
          status: 'ERROR',
          metric: 'new_coverage',
          metricName: 'new_coverage',
          comparator: 'LT',
          threshold: '80',
          formattedThreshold: '80',
          actualValue: '62.4',
          formattedActualValue: '62.4',
        },
        {
          status: 'OK',
          metric: 'new_bugs',
          metricName: 'new_bugs',
          comparator: 'GT',
          threshold: '0',
          formattedThreshold: '0',
          actualValue: '0',
          formattedActualValue: '0',
        },
      ]);
    },
    { timeout: 15000 },
  );

  it(
    'enriches conditions with metric name and type-aware formatted values (RATING/PERCENT/INT/WORK_DUR)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          { key: 'new_security_rating', type: 'RATING', name: 'Security Rating on New Code' },
          { key: 'new_coverage', type: 'PERCENT', name: 'Coverage on New Code' },
          { key: 'new_violations', type: 'INT', name: 'New Issues' },
          { key: 'sqale_index', type: 'WORK_DUR', name: 'Technical Debt' },
        ])
        .withProject('my-project', (p) =>
          p.withProjectStatus('ERROR').withConditions([
            {
              status: 'ERROR',
              metricKey: 'new_security_rating',
              comparator: 'GT',
              errorThreshold: '1',
              actualValue: '3',
            },
            {
              status: 'ERROR',
              metricKey: 'new_coverage',
              comparator: 'LT',
              errorThreshold: '80',
              actualValue: '62.4',
            },
            {
              status: 'OK',
              metricKey: 'new_violations',
              comparator: 'GT',
              errorThreshold: '0',
              actualValue: '0',
            },
            {
              status: 'OK',
              metricKey: 'sqale_index',
              comparator: 'GT',
              errorThreshold: '480',
              actualValue: '150',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project --all`);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate.conditions).toContainEqual({
        status: 'ERROR',
        metric: 'new_security_rating',
        metricName: 'Security Rating on New Code',
        metricType: 'RATING',
        comparator: 'GT',
        threshold: '1',
        formattedThreshold: 'A',
        actualValue: '3',
        formattedActualValue: 'C',
      });
      expect(parsed.qualityGate.conditions).toContainEqual({
        status: 'ERROR',
        metric: 'new_coverage',
        metricName: 'Coverage on New Code',
        metricType: 'PERCENT',
        comparator: 'LT',
        threshold: '80',
        formattedThreshold: '80%',
        actualValue: '62.4',
        formattedActualValue: '62.4%',
      });
      expect(parsed.qualityGate.conditions).toContainEqual({
        status: 'OK',
        metric: 'new_violations',
        metricName: 'New Issues',
        metricType: 'INT',
        comparator: 'GT',
        threshold: '0',
        formattedThreshold: '0',
        actualValue: '0',
        formattedActualValue: '0',
      });
      expect(parsed.qualityGate.conditions).toContainEqual({
        status: 'OK',
        metric: 'sqale_index',
        metricName: 'Technical Debt',
        metricType: 'WORK_DUR',
        comparator: 'GT',
        threshold: '480',
        formattedThreshold: '480 min',
        actualValue: '150',
        formattedActualValue: '150 min',
      });
    },
    { timeout: 15000 },
  );

  it(
    'renders passing conditions with a green marker in the table when --all is given',
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

      const result = await harness.run(
        `get quality-gate --project my-project --all --format table`,
      );

      expect(result.stdout).toContain('new_coverage');
      expect(result.stdout).toContain('new_bugs');
      const coverageLine = result.stdout.split('\n').find((line) => line.includes('new_coverage'));
      const bugsLine = result.stdout.split('\n').find((line) => line.includes('new_bugs'));
      expect(coverageLine).toContain('✗');
      expect(bugsLine).toContain('✓');
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
      expect(result.stdout).toContain('Branch:       main (default)');
      expect(result.stdout).toContain('Conditions:');
      expect(result.stdout).toContain('new_coverage');
      expect(result.stdout).toContain('62.4');
      expect(result.stdout).toContain('(required ≥ 80)');
    },
    { timeout: 15000 },
  );

  it(
    'renders the metric name and type-aware formatted value in the table, not the raw key/value',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([
          { key: 'new_security_rating', type: 'RATING', name: 'Security Rating on New Code' },
        ])
        .withProject('my-project', (p) =>
          p.withProjectStatus('ERROR').withConditions([
            {
              status: 'ERROR',
              metricKey: 'new_security_rating',
              comparator: 'GT',
              errorThreshold: '1',
              actualValue: '3',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project --format table`);

      expect(result.stdout).not.toContain('new_security_rating');
      const conditionLine = result.stdout
        .split('\n')
        .find((line) => line.includes('Security Rating on New Code'));
      expect(conditionLine).toContain('C');
      expect(conditionLine).toContain('(required ≤ A)');
    },
    { timeout: 15000 },
  );

  it(
    'keeps a gap between label and value when a metric name overflows the label column',
    async () => {
      const longName = 'Severity of a licensing dependency risk';
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMetrics([{ key: 'sca_severity_licensing', type: 'INT', name: longName }])
        .withProject('my-project', (p) =>
          p.withProjectStatus('OK').withConditions([
            {
              status: 'OK',
              metricKey: 'sca_severity_licensing',
              comparator: 'GT',
              errorThreshold: '19',
              actualValue: '0',
            },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `get quality-gate --project my-project --all --format table`,
      );

      const conditionLine = result.stdout.split('\n').find((line) => line.includes(longName));
      expect(conditionLine).toContain(`${longName}  0`);
    },
    { timeout: 15000 },
  );

  it(
    'resolves the actual default branch name instead of assuming "main"',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK').withDefaultBranchName('master'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const jsonResult = await harness.run(`get quality-gate --project my-project`);
      const parsed = JSON.parse(jsonResult.stdout);
      expect(parsed.qualityGate.branch).toBe('master');

      const tableResult = await harness.run(`get quality-gate --project my-project --format table`);
      expect(tableResult.stdout).toContain('Branch:       master (default)');
      expect(tableResult.stdout).not.toContain('main');
    },
    { timeout: 15000 },
  );

  it(
    'shows the given branch without the default annotation',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `get quality-gate --project my-project --format table --branch feature-x`,
      );

      expect(result.stdout).toContain('Branch:       feature-x');
      expect(result.stdout).not.toContain('(default)');

      const requests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/qualitygates/project_status');
      expect(requests).toHaveLength(1);
      expect(requests[0].query.branch).toBe('feature-x');
    },
    { timeout: 15000 },
  );

  it(
    'shows the given pull request instead of a branch',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `get quality-gate --project my-project --format table --pull-request 42`,
      );

      expect(result.stdout).toContain('Pull Request: 42');
      expect(result.stdout).not.toContain('Branch:');

      const requests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/qualitygates/project_status');
      expect(requests).toHaveLength(1);
      expect(requests[0].query.pullRequest).toBe('42');
    },
    { timeout: 15000 },
  );

  it(
    'rejects --branch combined with --pull-request',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `get quality-gate --project my-project --branch feature-x --pull-request 42`,
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--branch and --pull-request cannot be used together');
    },
    { timeout: 15000 },
  );

  it(
    'fails with a hint when the project has no branch flagged as default',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK').withNoDefaultBranch())
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project`);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Could not determine the default branch');
      expect(result.stderr).toContain('Specify --branch <name> or --pull-request <id> instead.');
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
    'fails fast with a clear error when the project does not exist',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project does-not-exist`);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Project 'does-not-exist' does not exist or not accessible.");

      const statusRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/qualitygates/project_status');
      expect(statusRequests).toHaveLength(0);
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
        branch: 'main',
        conditions: [],
      });
    },
    { timeout: 15000 },
  );

  it(
    'reports NOT_COMPUTED and exits 1 when the server 404s a not-yet-analyzed branch',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withUnanalyzedBranch('feature-x'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project --branch feature-x`);

      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.qualityGate).toEqual({
        status: 'NOT_COMPUTED',
        project: 'my-project',
        branch: 'feature-x',
        conditions: [],
      });
    },
    { timeout: 15000 },
  );

  it(
    'shows the not-computed table verdict when the server 404s a not-yet-analyzed branch',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withUnanalyzedBranch('feature-x'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `get quality-gate --project my-project --branch feature-x --format table`,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Quality Gate: [⚠ Not computed]');
      expect(result.stdout).toContain('Branch:       feature-x');
      expect(result.stdout).toContain(
        "This branch either doesn't exist, hasn't been analyzed yet, or analysis ran but the quality gate status is not updated yet. You can run `sonar analyze` for local analysis.",
      );
    },
    { timeout: 15000 },
  );

  it(
    'shows an info hint to analyze locally when the table verdict is NOT_COMPUTED',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`get quality-gate --project my-project --format table`);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Quality Gate: [⚠ Not computed]');
      expect(result.stdout).toContain(
        "This branch either doesn't exist, hasn't been analyzed yet, or analysis ran but the quality gate status is not updated yet. You can run `sonar analyze` for local analysis.",
      );
    },
    { timeout: 15000 },
  );

  it(
    'says "pull request" instead of "branch" in the NOT_COMPUTED hint when scoped to a pull request',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `get quality-gate --project my-project --pull-request 42 --format table`,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(
        "This pull request either doesn't exist, hasn't been analyzed yet, or analysis ran but the quality gate status is not updated yet. You can run `sonar analyze` for local analysis.",
      );
    },
    { timeout: 15000 },
  );
});
