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

// Integration tests for importing GitHub repositories with `sonar import` on SonarQube Server.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type FakeSonarQubeServer, TestHarness } from '../../harness';

const GITHUB = { id: 'gh-id', key: 'my-github', type: 'github', url: 'https://api.github.com' };

function githubRepo(id: number, fullName: string, extra: Record<string, unknown> = {}) {
  const name = fullName.split('/').at(-1) ?? fullName;
  return { id, key: fullName, name, url: `https://github.com/${fullName}`, ...extra };
}

interface BoundProjectPayload {
  projectKey: string;
  projectName: string;
  devOpsPlatformSettingId: string;
  repositoryIdentifier: string;
  projectIdentifier?: string;
  monorepo: boolean;
}

function postPayloads(server: FakeSonarQubeServer): BoundProjectPayload[] {
  return server
    .getRecordedRequests()
    .filter((r) => r.path === '/api/v2/dop-translation/bound-projects' && r.method === 'POST')
    .map((r) => JSON.parse(r.body ?? '{}') as BoundProjectPayload);
}

describe('sonar import: GitHub on SonarQube Server', () => {
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
    const builder = harness.newFakeServer().withAuthToken('test-token').withDopSettings([GITHUB]);
    configure(builder);
    const server = await builder.start();
    harness.withAuth(server.baseUrl(), 'test-token');
    return server;
  }

  it('probes the token, then lists every organization and its repositories with --all', async () => {
    const server = await startServer((s) =>
      s.withGithubOrganizations('my-github', [
        { key: 'acme', repos: [githubRepo(1, 'acme/api'), githubRepo(2, 'acme/web')] },
        { key: 'octo', repos: [githubRepo(3, 'octo/tool')] },
      ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 3 repositories');
    const paths = server.getRecordedRequests().map((r) => r.path);
    expect(paths).not.toContain('/api/alm_integrations/check_pat');
    const organizationCalls = server
      .getRecordedRequests()
      .filter((r) => r.path === '/api/alm_integrations/list_github_organizations');
    expect(organizationCalls[0].query).toEqual({ almSetting: 'my-github' });
    const repositoryCalls = server
      .getRecordedRequests()
      .filter((r) => r.path === '/api/alm_integrations/list_github_repositories');
    expect(repositoryCalls.map((r) => r.query.organization)).toEqual(['acme', 'octo']);
    expect(repositoryCalls.every((r) => r.query.almSetting === 'my-github')).toBe(true);
  });

  it('reports truncated discovery and imports only the bounded subset', async () => {
    const repositories = Array.from({ length: 1500 }, (_, i) =>
      githubRepo(i + 1, `acme/repo-${i}`),
    );
    const server = await startServer((s) =>
      s.withGithubOrganizations('my-github', [{ key: 'acme', repos: repositories }]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "discovery is incomplete for organization 'acme'",
    );
    expect(result.stdout + result.stderr).toContain(
      'Imported 1000 repositories from the discovered subset',
    );
    expect(putPayloads(server)).toHaveLength(1000);
    const pages = server
      .getRecordedRequests()
      .filter((request) => request.path === '/api/alm_integrations/list_github_repositories')
      .map((request) => Number(request.query.p));
    expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('continues into later organizations after truncation and retains the incomplete outcome', async () => {
    const repositories = Array.from({ length: 1500 }, (_, i) =>
      githubRepo(i + 1, `acme/repo-${i}`, { sqProjectKey: `acme_${i}` }),
    );
    const server = await startServer((s) =>
      s.withGithubOrganizations('my-github', [
        { key: 'acme', repos: repositories },
        { key: 'octo', repos: [githubRepo(2000, 'octo/api')] },
      ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'Imported 1 repository from the discovered subset',
    );
    expect(putPayloads(server).map((payload) => payload.repositoryIdentifier)).toEqual([
      'octo/api',
    ]);
  });

  it('finds an explicit repository beyond the listing cap with a filtered request', async () => {
    const repositories = Array.from({ length: 1500 }, (_, i) =>
      githubRepo(i + 1, `acme/repo-${i}`),
    );
    const server = await startServer((s) =>
      s.withGithubOrganizations('my-github', [{ key: 'acme', repos: repositories }]),
    );

    const result = await harness.run('import --repo acme/repo-1499');

    expect(result.exitCode).toBe(0);
    expect(putPayloads(server).map((payload) => payload.repositoryIdentifier)).toEqual([
      'acme/repo-1499',
    ]);
    const requests = server
      .getRecordedRequests()
      .filter((request) => request.path === '/api/alm_integrations/list_github_repositories');
    expect(requests).toHaveLength(1);
    expect(requests[0].query).toMatchObject({ organization: 'acme', q: 'repo-1499', p: '1' });
  });

  it('finds an explicit owner on a later organization page', async () => {
    const organizations = Array.from({ length: 101 }, (_, i) => ({
      key: `org${i}`,
      repos: [githubRepo(i + 1, `org${i}/api`)],
    }));
    const server = await startServer((s) => s.withGithubOrganizations('my-github', organizations));

    const result = await harness.run('import --repo org100/api');

    expect(result.exitCode).toBe(0);
    expect(putPayloads(server).map((payload) => payload.repositoryIdentifier)).toEqual([
      'org100/api',
    ]);
    expect(
      server
        .getRecordedRequests()
        .some(
          (request) =>
            request.path === '/api/alm_integrations/list_github_organizations' &&
            request.query.p === '2',
        ),
    ).toBe(true);
  });

  it('does not query repositories for an owner outside the visible organizations', async () => {
    const server = await startServer((s) =>
      s.withGithubOrganizations('my-github', [{ key: 'acme', repos: [githubRepo(1, 'acme/api')] }]),
    );

    const result = await harness.run('import --repo other/api');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('not found');
    expect(putPayloads(server)).toEqual([]);
    expect(
      server
        .getRecordedRequests()
        .filter((request) => request.path === '/api/alm_integrations/list_github_repositories'),
    ).toEqual([]);
  });

  it('shares organization pages across several explicit repository selections', async () => {
    const organizations = Array.from({ length: 101 }, (_, i) => ({
      key: `org${i}`,
      repos: [githubRepo(i * 2 + 1, `org${i}/api`), githubRepo(i * 2 + 2, `org${i}/web`)],
    }));
    const server = await startServer((s) => s.withGithubOrganizations('my-github', organizations));

    const result = await harness.run('import --repo org0/api --repo org100/api --repo org100/web');

    expect(result.exitCode).toBe(0);
    expect(
      putPayloads(server)
        .map((payload) => payload.repositoryIdentifier)
        .sort(),
    ).toEqual(['org0/api', 'org100/api', 'org100/web']);
    const pages = server
      .getRecordedRequests()
      .filter(
        (request) =>
          request.path === '/api/alm_integrations/list_github_organizations' && request.query.p,
      )
      .map((request) => Number(request.query.p));
    expect(pages).toEqual([1, 2]);
  });

  it.each([
    { count: 150, exactIndex: 120, pages: [1, 2], succeeds: true },
    { count: 150, exactIndex: -1, pages: [1, 2], succeeds: false },
    { count: 100, exactIndex: -1, pages: [1], succeeds: false },
    { count: 1500, exactIndex: 999, pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], succeeds: true },
    { count: 1500, exactIndex: 1499, pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], succeeds: false },
  ])(
    'bounds filtered lookup with $count matches and exact index $exactIndex',
    async ({ count, exactIndex, pages, succeeds }) => {
      const repositories = Array.from({ length: count }, (_, i) =>
        githubRepo(i + 1, i === exactIndex ? 'acme/api' : `acme/api-${i}`),
      );
      const server = await startServer((s) =>
        s.withGithubOrganizations('my-github', [{ key: 'acme', repos: repositories }]),
      );

      const result = await harness.run('import --repo acme/api');

      expect(result.exitCode).toBe(succeeds ? 0 : 1);
      expect(putPayloads(server).map((payload) => payload.repositoryIdentifier)).toEqual(
        succeeds ? ['acme/api'] : [],
      );
      if (!succeeds) {
        const output = result.stdout + result.stderr;
        if (count > 1000) {
          expect(output).toContain("GitHub repository lookup is incomplete for 'acme/api'");
          expect(output).toContain('The repository may exist beyond this limit.');
          expect(output).not.toContain('not found');
        } else {
          expect(output).toContain('not found');
        }
      }
      const requests = server
        .getRecordedRequests()
        .filter((request) => request.path === '/api/alm_integrations/list_github_repositories');
      expect(requests.map((request) => Number(request.query.p))).toEqual([...pages]);
      expect(requests.every((request) => request.query.q === 'api')).toBe(true);
    },
  );

  it('rejects a search result whose full name does not exactly match the explicit selection', async () => {
    const server = await startServer((s) =>
      s.withGithubOrganizations('my-github', [
        { key: 'acme', repos: [githubRepo(1, 'acme/api-extra')] },
      ]),
    );

    const result = await harness.run('import --repo acme/api');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('not found');
    expect(putPayloads(server)).toEqual([]);
  });

  it('sends the full name as repositoryIdentifier and derives the project key from it', async () => {
    const server = await startServer((s) =>
      s.withGithubOrganizations('my-github', [
        { key: 'acme', repos: [githubRepo(1, 'acme/api.v2')] },
      ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(postPayloads(server)).toEqual([
      {
        projectKey: 'acme_api.v2',
        projectName: 'api.v2',
        devOpsPlatformSettingId: 'gh-id',
        repositoryIdentifier: 'acme/api.v2',
        monorepo: false,
      },
    ]);
  });

  it('imports only the repository named by --repo as owner/repo', async () => {
    const server = await startServer((s) =>
      s.withGithubOrganizations('my-github', [
        { key: 'acme', repos: [githubRepo(1, 'acme/api'), githubRepo(2, 'acme/web')] },
        { key: 'octo', repos: [githubRepo(3, 'octo/api')] },
      ]),
    );

    const result = await harness.run('import --repo octo/api');

    expect(result.exitCode).toBe(0);
    expect(postPayloads(server).map((p) => p.repositoryIdentifier)).toEqual(['octo/api']);
  });

  it('pages through the repositories of several organizations', async () => {
    const acme = Array.from({ length: 120 }, (_, i) => githubRepo(1000 + i, `acme/repo-${i}`));
    const octo = Array.from({ length: 30 }, (_, i) => githubRepo(2000 + i, `octo/repo-${i}`));
    const server = await startServer((s) =>
      s.withGithubOrganizations('my-github', [
        { key: 'acme', repos: acme },
        { key: 'octo', repos: octo },
      ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 150 repositories');
    expect(postPayloads(server)).toHaveLength(150);
    const acmeCalls = server
      .getRecordedRequests()
      .filter(
        (r) =>
          r.path === '/api/alm_integrations/list_github_repositories' &&
          r.query.organization === 'acme',
      );
    expect(acmeCalls.map((r) => r.query.p)).toEqual(['1', '2']);
  });

  it('skips repositories that are already bound to a project, without failing', async () => {
    const server = await startServer((s) =>
      s.withGithubOrganizations('my-github', [
        {
          key: 'acme',
          repos: [
            githubRepo(1, 'acme/api', { sqProjectKey: 'acme_api' }),
            githubRepo(2, 'acme/web'),
          ],
        },
      ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 1 repository');
    expect(result.stdout).toContain('already imported');
    expect(postPayloads(server).map((p) => p.repositoryIdentifier)).toEqual(['acme/web']);
  });

  it('fails when no organization has a repository', async () => {
    const server = await startServer((s) =>
      s.withGithubOrganizations('my-github', [{ key: 'acme', repos: [] }]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'No repositories found for this DevOps platform.',
    );
    expect(postPayloads(server)).toHaveLength(0);
  });

  it('fails with the connect URL when GitHub returns no organizations for the token', async () => {
    const server = await startServer((s) => s.withGithubOrganizations('my-github', []));

    const result = await harness.run('import --non-interactive --all');

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain("GitHub returned no organizations for setting 'my-github':");
    expect(output).toContain(`${server.baseUrl()}/projects/create?mode=github&dopSetting=gh-id`);
    expect(output).not.toContain('resetPat');
    expect(
      server
        .getRecordedRequests()
        .some((r) => r.path === '/api/alm_integrations/list_github_repositories'),
    ).toBe(false);
    expect(postPayloads(server)).toHaveLength(0);
  });

  it('prints the connect URL with dopSetting when no token is connected, and lists nothing', async () => {
    const server = await startServer((s) =>
      s
        .withGithubOrganizations('my-github', [{ key: 'acme', repos: [githubRepo(1, 'acme/api')] }])
        .withPatResponse('my-github', {
          status: 400,
          message: 'No personal access token found',
        }),
    );

    const result = await harness.run('import --non-interactive --all');

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain(
      "No personal access token is connected for GitHub setting 'my-github'.",
    );
    expect(output).toContain(`${server.baseUrl()}/projects/create?mode=github&dopSetting=gh-id,`);
    expect(
      server
        .getRecordedRequests()
        .some((r) => r.path === '/api/alm_integrations/list_github_repositories'),
    ).toBe(false);
    expect(postPayloads(server)).toHaveLength(0);
  });
});
