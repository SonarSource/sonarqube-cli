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

// Integration tests for `quality-gate status` via the compiled binary + fake SonarQube server

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { commitFile, git, initGitRepo } from '../hook/git-test-helpers';

describe('quality-gate status', () => {
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

      const result = await harness.run(`quality-gate status --project my-project --format json`);

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
    'resolves via the qg alias',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`qg status --project my-project --format json`);

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
    'defaults to table format when --format is omitted',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Quality Gate: [✓ Passed]');
      expect(() => {
        JSON.parse(result.stdout);
      }).toThrow();
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

      await harness.run(`quality-gate status --project my-project`);

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

      await harness.run(`quality-gate status --project my-project`);

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

      await harness.run(`quality-gate status --project my-project --all`);

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

      const result = await harness.run(`quality-gate status --project my-project --format json`);

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

      const result = await harness.run(`quality-gate status --project my-project --format json`);

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

      const result = await harness.run(`quality-gate status --project my-project --format json`);

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

      const result = await harness.run(
        `quality-gate status --project my-project --all --format json`,
      );

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

      const result = await harness.run(
        `quality-gate status --project my-project --all --format json`,
      );

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
        `quality-gate status --project my-project --all --format table`,
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

      const result = await harness.run(`quality-gate status --project my-project --format table`);

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

      const result = await harness.run(`quality-gate status --project my-project --format table`);

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
        `quality-gate status --project my-project --all --format table`,
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

      const jsonResult = await harness.run(
        `quality-gate status --project my-project --format json`,
      );
      const parsed = JSON.parse(jsonResult.stdout);
      expect(parsed.qualityGate.branch).toBe('master');

      const tableResult = await harness.run(
        `quality-gate status --project my-project --format table`,
      );
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
        `quality-gate status --project my-project --format table --branch feature-x`,
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
        `quality-gate status --project my-project --format table --pull-request 42`,
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
    'auto-detects a pull request for the current git branch when no flags are given',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('OK').withPullRequests([{ key: '42', branch: 'feature-x' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'a.txt', 'a');
      git(['checkout', '-b', 'feature-x'], harness.cwd.path);

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      expect(result.stdout).toContain('Pull Request: 42 (auto-detected from branch feature-x)');

      const requests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/qualitygates/project_status');
      expect(requests).toHaveLength(1);
      expect(requests[0].query.pullRequest).toBe('42');
    },
    { timeout: 15000 },
  );

  it(
    'falls back to the default branch when no pull request matches the current git branch',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('OK').withPullRequests([{ key: '7', branch: 'other-branch' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'a.txt', 'a');
      git(['checkout', '-b', 'feature-x'], harness.cwd.path);

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      expect(result.stdout).toContain('Branch:       main (default)');
    },
    { timeout: 15000 },
  );

  it(
    'falls back to the default branch when more than one pull request matches the current git branch',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('OK').withPullRequests([
            { key: '1', branch: 'feature-x' },
            { key: '2', branch: 'feature-x' },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'a.txt', 'a');
      git(['checkout', '-b', 'feature-x'], harness.cwd.path);

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      expect(result.stdout).toContain('Branch:       main (default)');
    },
    { timeout: 15000 },
  );

  it(
    'falls back to the default branch when the server edition does not support pull request analysis',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK').withPullRequestsUnsupported())
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'a.txt', 'a');
      git(['checkout', '-b', 'feature-x'], harness.cwd.path);

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      expect(result.stdout).toContain('Branch:       main (default)');
    },
    { timeout: 15000 },
  );

  it(
    'falls back to the default branch instead of failing when the pull request lookup errors out',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK').withPullRequestsError(500))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'a.txt', 'a');
      git(['checkout', '-b', 'feature-x'], harness.cwd.path);

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Branch:       main (default)');
    },
    { timeout: 15000 },
  );

  it(
    'does not look up pull requests when --branch is given explicitly',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withProjectStatus('OK').withPullRequests([{ key: '42', branch: 'feature-x' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'a.txt', 'a');
      git(['checkout', '-b', 'feature-x'], harness.cwd.path);

      const result = await harness.run(
        `quality-gate status --project my-project --format table --branch feature-x`,
      );

      expect(result.stdout).toContain('Branch:       feature-x');
      expect(result.stdout).not.toContain('(default)');
      const pullRequestRequests = server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/project_pull_requests/list');
      expect(pullRequestRequests).toHaveLength(0);
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
        `quality-gate status --project my-project --branch feature-x --pull-request 42`,
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

      const result = await harness.run(`quality-gate status --project my-project`);

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

      const result = await harness.run(`quality-gate status --project my-project --format table`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Quality Gate: [✓ Passed]');
      expect(result.stdout).not.toContain('Conditions:');
    },
    { timeout: 15000 },
  );

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
      expect(parsed.qualityGate.conditions).toHaveLength(1);
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
      expect(parsed.qualityGate.conditions).toHaveLength(1);
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
      expect(parsed.qualityGate.conditions).toEqual([]);
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
      expect(parsed.qualityGate.conditions).toEqual([]);
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
        `quality-gate status --project my-project --category duplications`,
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "Invalid --category option: 'duplications'. Must be one of: coverage",
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

  it(
    'rejects an invalid --format value',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withProjectStatus('OK'))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`quality-gate status --project my-project --format yaml`);

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

      const result = await harness.run(`quality-gate status --project does-not-exist`);

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

      const result = await harness.run(`quality-gate status --project my-project --format json`);

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

      const result = await harness.run(
        `quality-gate status --project my-project --branch feature-x --format json`,
      );

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
        `quality-gate status --project my-project --branch feature-x --format table`,
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

      const result = await harness.run(`quality-gate status --project my-project --format table`);

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
        `quality-gate status --project my-project --pull-request 42 --format table`,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(
        "This pull request either doesn't exist, hasn't been analyzed yet, or analysis ran but the quality gate status is not updated yet. You can run `sonar analyze` for local analysis.",
      );
    },
    { timeout: 15000 },
  );
});
