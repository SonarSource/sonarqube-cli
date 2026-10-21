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

import { readCommandEvents } from '../../../_common/telemetry-helpers';
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
        "Project 'missing-project' could not be found or is not accessible.",
      );
      expect(result.stderr).toContain(
        "Run 'sonar list org' to check your organization membership.",
      );
      expect(result.stdout).not.toContain('No issues found');
      expect(result.stdout).not.toContain('"issues"');
      expect(
        server.getRecordedRequests().filter((r) => r.path === '/api/issues/search'),
      ).toHaveLength(0);
      const lookup = server.getRecordedRequests().find((r) => r.path === '/api/components/show');
      expect(lookup?.query).toEqual({ component: 'missing-project' });
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
      const lookup = server.getRecordedRequests().find((r) => r.path === '/api/components/show');
      expect(lookup?.query).toEqual({ component: 'my-project' });
    },
  );

  it('validates project membership with one exact lookup before returning populated results', async () => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project-suffix')
      .withProject('my-project', (p) => p.withIssue({ ruleKey: 'java:S100', message: 'Fix this' }))
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).issues).toHaveLength(1);
    const requests = server.getRecordedRequests();
    const lookups = requests.filter((r) => r.path === '/api/components/show');
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.query).toEqual({ component: 'my-project' });
    expect(requests.indexOf(lookups[0])).toBeLessThan(
      requests.findIndex((r) => r.path === '/api/issues/search'),
    );
    expect(requests.some((r) => r.path === '/api/components/search')).toBe(false);
  });

  it('rejects a different organization before file, branch, mode, or populated issue lookups', async () => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project', (p) =>
        p.withOrganization('other-org').withIssue({ ruleKey: 'java:S100', message: 'Fix this' }),
      )
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run(
      'list issues --project my-project --file src/foo.ts --severities HIGH',
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Project 'my-project' belongs to organization 'other-org', but the active organization is 'my-org'.",
    );
    expect(result.stderr).toContain(
      "Run 'sonar auth org other-org' to switch to that organization.",
    );
    expect(result.stdout).not.toContain('"issues"');
    expect(server.getRecordedRequests().map((r) => r.path)).toEqual(['/api/components/show']);
  });

  it.each([undefined, ''])('rejects absent organization metadata (%s)', async (organization) => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project', (p) => p.withOrganization(organization))
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Project 'my-project' could not be found or is not accessible.",
    );
    expect(result.stderr).toContain("Run 'sonar list org' to check your organization membership.");
    expect(server.getRecordedRequests().map((r) => r.path)).toEqual(['/api/components/show']);
  });

  it.each([403, 500, 429, 401])('rejects a project lookup failure with HTTP %s', async (status) => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project', (p) => p.withComponentShowError(status))
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(1);
    if (status === 403) {
      expect(result.stderr).toContain(
        "Project 'my-project' could not be found or is not accessible.",
      );
      expect(result.stderr).toContain(
        "Run 'sonar list org' to check your organization membership.",
      );
    } else {
      expect(result.stderr).toContain(
        status === 429 ? 'Rate limit reached (429)' : `SonarQube API error: ${status}`,
      );
      expect(result.stderr).not.toContain('organization membership');
    }
    expect(result.stdout).not.toContain('"issues"');
    expect(server.getRecordedRequests().map((r) => r.path)).toEqual(['/api/components/show']);
  });

  it('records a failed command when the organization check rejects the project', async () => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project', (p) => p.withOrganization('other-org'))
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');
    harness.state().withTelemetryEnabled();

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(1);
    const [event] = readCommandEvents(harness.sonarUserHome.path);
    expect(event.event_payload.command).toBe('list');
    expect(event.event_payload.result).toBe('failure');
  });

  it('preserves Server empty-result behavior without a membership lookup', async () => {
    const server = await harness
      .newFakeServer()
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
