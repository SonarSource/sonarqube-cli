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
        "Project 'missing-project' not found in organization 'my-org'.",
      );
      expect(result.stdout).not.toContain('No issues found');
      expect(result.stdout).not.toContain('"issues"');
      const lookup = server.getRecordedRequests().find((r) => r.path === '/api/components/search');
      expect(lookup?.query.organization).toBe('my-org');
      expect(lookup?.query.q).toBe('missing-project');
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
      const lookup = server.getRecordedRequests().find((r) => r.path === '/api/components/search');
      expect(lookup?.query.q).toBe('my-project');
    },
  );

  it('finds the exact project on a later search page', async () => {
    const builder = harness.newFakeServer().asSonarCloud().withAuthToken('test-token');
    const firstPageSize = 500;
    for (let i = 0; i < firstPageSize; i += 1) builder.withProject(`my-project-${i}`);
    const server = await builder.withProject('my-project').start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).issues).toEqual([]);
    const lookups = server.getRecordedRequests().filter((r) => r.path === '/api/components/search');
    expect(lookups.map((r) => r.query.p)).toEqual(['1', '2']);
  });

  it('propagates a project lookup failure', async () => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project')
      .withProjectsSearchError(403, JSON.stringify({ errors: [{ msg: 'Lookup forbidden' }] }))
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Access denied (HTTP 403)');
    expect(result.stderr).not.toContain('not found in organization');
  });

  it('skips the membership lookup when issues are present', async () => {
    const server = await harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken('test-token')
      .withProject('my-project', (p) =>
        p.withIssue({ ruleKey: 'java:S100', message: 'Fix this', severity: 'MAJOR' }),
      )
      .withProjectsSearchError(403)
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'my-org');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).issues).toHaveLength(1);
    expect(server.getRecordedRequests().some((r) => r.path === '/api/components/search')).toBe(
      false,
    );
  });

  it('preserves Server empty-result behavior without a membership lookup', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('my-project')
      .withProjectsSearchError(403)
      .start();
    harness.withAuth(server.baseUrl(), 'test-token');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).issues).toEqual([]);
    expect(server.getRecordedRequests().some((r) => r.path === '/api/components/search')).toBe(
      false,
    );
  });
});
