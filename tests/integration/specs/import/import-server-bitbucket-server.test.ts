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

// Integration tests for importing Bitbucket Server repositories with `sonar import` on SonarQube Server.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type FakeSonarQubeServer, TestHarness } from '../../harness';

const BITBUCKET = {
  id: 'bb-id',
  key: 'my-bbs',
  type: 'bitbucket',
  url: 'https://bitbucket.example.com',
};

function bbsRepo(id: number, slug: string, extra: { sqProjectKey?: string } = {}) {
  return { id, slug, name: slug, ...extra };
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

describe('sonar import: Bitbucket Server on SonarQube Server', () => {
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
      .withDopSettings([BITBUCKET]);
    configure(builder);
    const server = await builder.start();
    harness.withAuth(server.baseUrl(), 'test-token');
    return server;
  }

  it('imports every repository with --all, sending the repository slug and the project key', async () => {
    const server = await startServer((s) =>
      s.withBitbucketServerProjects('my-bbs', [
        { key: 'ALPHA', name: 'Alpha', repos: [bbsRepo(11, 'repo-a'), bbsRepo(12, 'repo-b')] },
        { key: 'BETA', name: 'Beta', repos: [bbsRepo(21, 'repo-c')] },
      ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 3 repositories');
    expect(result.stdout).toContain(`Projects: ${server.baseUrl()}/projects`);
    const payloads = putPayloads(server);
    expect(payloads).toHaveLength(3);
    expect(payloads).toContainEqual({
      projectKey: 'ALPHA_repo-a',
      projectName: 'repo-a',
      devOpsPlatformSettingId: 'bb-id',
      repositoryIdentifier: 'repo-a',
      projectIdentifier: 'ALPHA',
      monorepo: false,
    });
    expect(payloads.map((p) => [p.projectIdentifier, p.repositoryIdentifier]).sort()).toEqual([
      ['ALPHA', 'repo-a'],
      ['ALPHA', 'repo-b'],
      ['BETA', 'repo-c'],
    ]);
  });

  it('pages through the projects and through the repositories of each project', async () => {
    const server = await startServer((s) =>
      s.withBitbucketServerProjects(
        'my-bbs',
        [
          {
            key: 'ALPHA',
            name: 'Alpha',
            repos: [bbsRepo(11, 'a1'), bbsRepo(12, 'a2'), bbsRepo(13, 'a3')],
          },
          { key: 'BETA', name: 'Beta', repos: [] },
          { key: 'GAMMA', name: 'Gamma', repos: [bbsRepo(31, 'g1'), bbsRepo(32, 'g2')] },
        ],
        2,
      ),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 5 repositories');
    expect(
      putPayloads(server)
        .map((p) => `${p.projectIdentifier}/${p.repositoryIdentifier}`)
        .sort(),
    ).toEqual(['ALPHA/a1', 'ALPHA/a2', 'ALPHA/a3', 'GAMMA/g1', 'GAMMA/g2']);
    const requests = server.getRecordedRequests();
    const projectLists = requests.filter(
      (r) => r.path === '/api/alm_integration/list_bitbucketserver_projects',
    );
    expect(projectLists.map((r) => r.query.start)).toEqual(['0', '2']);
    expect(projectLists.every((r) => r.query.almSetting === 'my-bbs')).toBe(true);
    const searches = requests.filter(
      (r) => r.path === '/api/alm_integration/search_bitbucketserver_repos',
    );
    expect(searches.map((r) => [r.query.projectName, r.query.start])).toEqual([
      ['Alpha', '0'],
      ['Alpha', '2'],
      ['Beta', '0'],
      ['Gamma', '0'],
    ]);
  });

  it('serves more than one page of repositories to the picker', async () => {
    const repos = Array.from({ length: 60 }, (_, i) => bbsRepo(1000 + i, `repo-${i}`));
    const server = await startServer((s) =>
      s.withBitbucketServerProjects('my-bbs', [{ key: 'ALPHA', name: 'Alpha', repos }]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 60 repositories');
    expect(putPayloads(server)).toHaveLength(60);
  });

  it('imports only the repository named by --repo, as PROJECTKEY/slug', async () => {
    const server = await startServer((s) =>
      s.withBitbucketServerProjects('my-bbs', [
        { key: 'ALPHA', name: 'Alpha', repos: [bbsRepo(11, 'shared')] },
        { key: 'BETA', name: 'Beta', repos: [bbsRepo(21, 'shared')] },
      ]),
    );

    const result = await harness.run('import --repo BETA/shared');

    expect(result.exitCode).toBe(0);
    const payloads = putPayloads(server);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      projectKey: 'BETA_shared',
      repositoryIdentifier: 'shared',
      projectIdentifier: 'BETA',
    });
  });

  it('skips repositories that are already bound to a project, without failing', async () => {
    const server = await startServer((s) =>
      s.withBitbucketServerProjects('my-bbs', [
        {
          key: 'ALPHA',
          name: 'Alpha',
          repos: [bbsRepo(11, 'repo-a', { sqProjectKey: 'ALPHA_repo-a' }), bbsRepo(12, 'repo-b')],
        },
      ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 1 repository');
    expect(result.stdout).toContain('already imported');
    expect(putPayloads(server).map((p) => p.repositoryIdentifier)).toEqual(['repo-b']);
  });

  it('fails when no repository is visible on the server', async () => {
    await startServer((s) => s.withBitbucketServerProjects('my-bbs', []));

    const result = await harness.run('import --non-interactive --all');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'No repositories found for this DevOps platform.',
    );
  });

  it('points to the Bitbucket connect page when no token is connected, before listing anything', async () => {
    const server = await startServer((s) =>
      s
        .withBitbucketServerProjects('my-bbs', [
          { key: 'ALPHA', name: 'Alpha', repos: [bbsRepo(11, 'repo-a')] },
        ])
        .withPatResponse('my-bbs', {
          status: 400,
          message: "personal access token for 'my-bbs' is missing",
        }),
    );

    const result = await harness.run('import --non-interactive --all');

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain(
      "No personal access token is connected for Bitbucket Server setting 'my-bbs'.",
    );
    expect(output).toContain(`${server.baseUrl()}/projects/create?mode=bitbucket,`);
    expect(
      server
        .getRecordedRequests()
        .some((r) => r.path === '/api/alm_integration/list_bitbucketserver_projects'),
    ).toBe(false);
  });
});
