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

// Integration tests for importing Bitbucket Cloud repositories with `sonar import` on SonarQube Server.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type FakeSonarQubeServer, TestHarness } from '../../harness';

const BITBUCKET_CLOUD = {
  id: 'bbc-id',
  key: 'my-bbc',
  type: 'bitbucketcloud',
  url: 'https://bitbucket.org',
};

function bbcRepo(slug: string, extra: Record<string, unknown> = {}) {
  return {
    slug,
    uuid: `{uuid-${slug}}`,
    name: slug,
    workspace: 'acme',
    projectKey: 'PRJ',
    ...extra,
  };
}

interface BoundProjectPayload {
  projectKey: string;
  projectName: string;
  devOpsPlatformSettingId: string;
  repositoryIdentifier: string;
  projectIdentifier?: string;
  monorepo: boolean;
}

function putPayloads(server: FakeSonarQubeServer): BoundProjectPayload[] {
  return server
    .getRecordedRequests()
    .filter((r) => r.path === '/api/v2/dop-translation/bound-projects' && r.method === 'PUT')
    .map((r) => JSON.parse(r.body ?? '{}') as BoundProjectPayload);
}

describe('sonar import: Bitbucket Cloud on SonarQube Server', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function startServer(
    configure: (server: ReturnType<TestHarness['newFakeServer']>) => void,
  ): Promise<FakeSonarQubeServer> {
    const builder = harness
      .newFakeServer()
      .withAuthToken('test-token')
      .withDopSettings([BITBUCKET_CLOUD]);
    configure(builder);
    const server = await builder.start();
    harness.withAuth(server.baseUrl(), 'test-token');
    return server;
  }

  it('imports every repository with --all, identifying each by its slug', async () => {
    const server = await startServer((s) =>
      s.withBitbucketCloudRepos('my-bbc', [bbcRepo('repo-a'), bbcRepo('repo-b')]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 2 repositories');
    expect(result.stdout).toContain(`Projects: ${server.baseUrl()}/projects`);
    const payloads = putPayloads(server);
    expect(payloads).toHaveLength(2);
    expect(payloads).toContainEqual({
      projectKey: 'acme_repo-a',
      projectName: 'repo-a',
      devOpsPlatformSettingId: 'bbc-id',
      repositoryIdentifier: 'repo-a',
      monorepo: false,
    });
    expect(payloads.every((p) => !('projectIdentifier' in p))).toBe(true);
  });

  it('imports only the repository named by --repo, as workspace/slug', async () => {
    const server = await startServer((s) =>
      s.withBitbucketCloudRepos('my-bbc', [bbcRepo('repo-a'), bbcRepo('repo-b')]),
    );

    const result = await harness.run('import --repo acme/repo-b');

    expect(result.exitCode).toBe(0);
    expect(putPayloads(server).map((p) => p.repositoryIdentifier)).toEqual(['repo-b']);
  });

  it('skips repositories that are already bound to a project, without failing', async () => {
    const server = await startServer((s) =>
      s.withBitbucketCloudRepos('my-bbc', [
        bbcRepo('repo-a', { sqProjectKey: 'acme_repo-a' }),
        bbcRepo('repo-b'),
      ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 1 repository');
    expect(result.stdout).toContain('already imported');
    expect(putPayloads(server).map((p) => p.repositoryIdentifier)).toEqual(['repo-b']);
  });

  it('pages through every repository', async () => {
    const repos = Array.from({ length: 120 }, (_, i) => bbcRepo(`repo-${i}`));
    const server = await startServer((s) => s.withBitbucketCloudRepos('my-bbc', repos));

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 120 repositories');
    expect(putPayloads(server)).toHaveLength(120);
    const searches = server
      .getRecordedRequests()
      .filter((r) => r.path === '/api/alm_integrations/search_bitbucketcloud_repos');
    expect(searches.map((r) => r.query.p)).toEqual(['1', '2', '3']);
    expect(searches.every((r) => r.query.almSetting === 'my-bbc' && r.query.ps === '50')).toBe(
      true,
    );
  });

  it('points to the Bitbucket Cloud connect page when no token is connected', async () => {
    const server = await startServer((s) =>
      s.withBitbucketCloudRepos('my-bbc', [bbcRepo('repo-a')]).withPatResponse('my-bbc', {
        status: 400,
        message: "personal access token for 'my-bbc' is missing",
      }),
    );

    const result = await harness.run('import --non-interactive --all');

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain(
      "No personal access token is connected for Bitbucket Cloud setting 'my-bbc'.",
    );
    expect(output).toContain(`${server.baseUrl()}/projects/create?mode=bitbucketcloud,`);
    expect(
      server
        .getRecordedRequests()
        .some((r) => r.path === '/api/alm_integrations/search_bitbucketcloud_repos'),
    ).toBe(false);
  });
});
