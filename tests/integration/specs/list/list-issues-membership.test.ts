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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('list issues — project membership', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it.each(['json', 'toon', 'table', 'csv'])(
    'rejects a missing project before printing %s output',
    async (format) => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('test-token')
        .withProject('missing-project-suffix')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

      const result = await harness.run(`list issues --project missing-project --format ${format}`);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Project 'missing-project' not found in organization 'my-org', or you do not have access to it.",
      );
      expect(result.stderr).toContain(
        "Check the key with 'sonar list projects' and the organization with 'sonar auth status'.",
      );
      expect(result.stdout).not.toContain('No issues found');
      expect(result.stdout).not.toContain('"issues"');
      const lookup = server.getRecordedRequests().find((r) => r.path === '/api/components/show');
      expect(lookup?.query.component).toBe('missing-project');
    },
  );

  it.each(['', '--statuses FIXED', '--page 2', '--file src/foo.ts'])(
    'preserves an empty result for an existing project with %s',
    async (options) => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withComponentsTreeItems([{ path: 'src/foo.ts', qualifier: 'FIL' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

      const result = await harness.run(`list issues --project my-project ${options}`);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).issues).toEqual([]);
      const lookup = server
        .getRecordedRequests()
        .find((r) => r.path === '/api/components/show' && r.query.component === 'my-project');
      expect(lookup).toBeDefined();
    },
  );

  it('validates project membership with one exact lookup', async () => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project-suffix')
      .withProject('my-project')
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).issues).toEqual([]);
    const lookups = server.getRecordedRequests().filter((r) => r.path === '/api/components/show');
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.query.component).toBe('my-project');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/components/search')).toBe(
      false,
    );
  });

  it('rejects a browsable project in a different organization', async () => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project', (p) => p.withOrganization('other-org'))
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "not found in organization 'my-org', or you do not have access to it.",
    );
  });

  it('reports an inaccessible project when the response omits organization metadata', async () => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project', (p) => p.withOrganization(undefined))
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('or you do not have access to it.');
  });

  it.each([403, 500])('handles a project lookup failure with HTTP %s', async (status) => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project', (p) => p.withComponentShowError(status))
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('list issues --project my-project');

    if (status === 403) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Project 'my-project' not found in organization 'my-org', or you do not have access to it.",
      );
      expect(result.stderr).toContain(
        "Check the key with 'sonar list projects' and the organization with 'sonar auth status'.",
      );
      expect(result.stdout).not.toContain('"issues"');
      return;
    }

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).issues).toEqual([]);
    expect(result.stderr).not.toContain('Lookup failed');
    expect(result.stderr).not.toContain('not found in organization');
    const logFile = harness.cliHome.file('logs', 'sonarqube-cli.log');
    expect(logFile.exists() ? logFile.asText() : '').not.toContain(
      'Project membership lookup failed',
    );

    const debugResult = await harness.run('list issues --project my-project', {
      extraEnv: { LOG_LEVEL: 'DEBUG' },
    });
    expect(debugResult.exitCode).toBe(0);
    expect(logFile.asText()).toContain(
      '[DEBUG] Project membership lookup failed; keeping the empty issue result.',
    );
    expect(logFile.asText()).toContain(String(status));
  });

  it('skips the membership lookup when issues are present', async () => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project', (p) =>
        p
          .withIssue({ ruleKey: 'java:S100', message: 'Fix this', severity: 'MAJOR' })
          .withComponentShowError(403),
      )
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).issues).toHaveLength(1);
    expect(server.getRecordedRequests().some((r) => r.path === '/api/components/show')).toBe(false);
  });

  it('preserves Server empty-result behavior without a membership lookup', async () => {
    const builder = harness.newFakeServer();
    const server = await builder
      .withAuthToken('test-token')
      .withProject('my-project', (p) => p.withComponentShowError(403))
      .start();
    harness.withAuth(server.baseUrl(), 'test-token');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).issues).toEqual([]);
    expect(server.getRecordedRequests().some((r) => r.path === '/api/components/show')).toBe(false);
  });
});
