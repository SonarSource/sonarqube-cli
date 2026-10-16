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

// Integration tests for importing GitLab repositories with `sonar import` on SonarQube Server.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type FakeSonarQubeServer, TestHarness } from '../../harness';

const GITLAB = { id: 'gl-id', key: 'my-gitlab', type: 'gitlab', url: 'https://gitlab.example.com' };

function gitlabRepo(id: number, path: string, extra: Record<string, unknown> = {}) {
  const parts = path.split('/');
  const slug = parts.at(-1) ?? path;
  return {
    id,
    name: slug,
    pathName: parts.slice(0, -1).join(' / '),
    slug,
    pathSlug: parts.slice(0, -1).join('/'),
    url: `https://gitlab.example.com/${path}`,
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

describe('sonar import: GitLab on SonarQube Server', () => {
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
    const builder = harness.newFakeServer().withAuthToken('test-token').withDopSettings([GITLAB]);
    configure(builder);
    const server = await builder.start();
    harness.withAuth(server.baseUrl(), 'test-token');
    return server;
  }

  it('imports every repository with --all, deriving the project key from the path', async () => {
    const server = await startServer((s) =>
      s.withGitlabRepos('my-gitlab', [gitlabRepo(11, 'group/sub/repo-a'), gitlabRepo(12, 'solo')]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 2 repositories');
    expect(result.stdout).toContain(`Projects: ${server.baseUrl()}/projects`);
    const payloads = putPayloads(server);
    expect(payloads).toHaveLength(2);
    expect(payloads).toContainEqual({
      projectKey: 'group_sub_repo-a',
      projectName: 'repo-a',
      devOpsPlatformSettingId: 'gl-id',
      repositoryIdentifier: '11',
      monorepo: false,
    });
    expect(payloads.map((p) => p.projectKey)).toContain('solo');
    expect(payloads.every((p) => !('projectIdentifier' in p))).toBe(true);
  });

  it('imports only the repositories named by --repo, by full path', async () => {
    const server = await startServer((s) =>
      s.withGitlabRepos('my-gitlab', [
        gitlabRepo(11, 'group/repo-a'),
        gitlabRepo(12, 'group/repo-b'),
      ]),
    );

    const result = await harness.run('import --repo group/repo-b');

    expect(result.exitCode).toBe(0);
    expect(putPayloads(server).map((p) => p.repositoryIdentifier)).toEqual(['12']);
  });

  it('fails when a --repo path is not found, without importing anything', async () => {
    const server = await startServer((s) =>
      s.withGitlabRepos('my-gitlab', [gitlabRepo(11, 'group/repo-a')]),
    );

    const result = await harness.run('import --repo group/missing');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('group/missing');
    expect(putPayloads(server)).toHaveLength(0);
  });

  it('imports only the repositories whose name matches --regex', async () => {
    const server = await startServer((s) =>
      s.withGitlabRepos('my-gitlab', [
        gitlabRepo(11, 'group/api-service'),
        gitlabRepo(12, 'group/web-app'),
        gitlabRepo(13, 'group/api-gateway'),
      ]),
    );

    const result = await harness.run('import --regex ^api-');

    expect(result.exitCode).toBe(0);
    expect(
      putPayloads(server)
        .map((p) => p.repositoryIdentifier)
        .sort(),
    ).toEqual(['11', '13']);
  });

  it('skips repositories that are already bound to a project, without failing', async () => {
    const server = await startServer((s) =>
      s.withGitlabRepos('my-gitlab', [
        gitlabRepo(11, 'group/repo-a', { sqProjectKey: 'group_repo-a', sqProjectName: 'repo-a' }),
        gitlabRepo(12, 'group/repo-b'),
      ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 1 repository');
    expect(result.stdout).toContain('already imported');
    expect(putPayloads(server).map((p) => p.repositoryIdentifier)).toEqual(['12']);
  });

  it('refuses to --repo a repository that is already bound', async () => {
    const server = await startServer((s) =>
      s.withGitlabRepos('my-gitlab', [
        gitlabRepo(11, 'group/repo-a', { sqProjectKey: 'group_repo-a' }),
      ]),
    );

    const result = await harness.run('import --repo group/repo-a');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('has already been imported');
    expect(putPayloads(server)).toHaveLength(0);
  });

  it('reports a project that already existed as imported instead of failing', async () => {
    await startServer((s) =>
      s
        .withGitlabRepos('my-gitlab', [gitlabRepo(11, 'group/repo-a')])
        .withProjectBindings([
          { projectKey: 'group_repo-a', repository: '11', dopSettingId: 'gl-id' },
        ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 1 repository');
    expect(result.stdout).toContain('project already existed, binding updated');
  });

  it('does not rebind an existing project that is not bound to the repository', async () => {
    const server = await startServer((s) =>
      s
        .withGitlabRepos('my-gitlab', [
          gitlabRepo(11, 'group/repo-a'),
          gitlabRepo(12, 'group/repo-b'),
          gitlabRepo(13, 'group/repo-c'),
        ])
        .withProject('group_repo-a')
        .withProjectBindings([
          { projectKey: 'group_repo-b', repository: '99', dopSettingId: 'gl-id' },
        ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain('Imported 1 of 3 repositories (2 failed)');
    expect(output).toContain(
      "A project with key 'group_repo-a' already exists and is not bound to group/repo-a; the CLI did not change it.",
    );
    expect(putPayloads(server).map((p) => p.repositoryIdentifier)).toEqual(['13']);
  });

  it('keeps importing the others and exits 1 when one repository fails', async () => {
    const server = await startServer((s) =>
      s
        .withGitlabRepos('my-gitlab', [
          gitlabRepo(11, 'group/repo-a'),
          gitlabRepo(12, 'group/repo-b'),
        ])
        .withBoundProjectFailure('11', 500, 'failed to fetch repository'),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain('Imported 1 of 2 repositories (1 failed)');
    expect(output).toContain('group/repo-a');
    expect(putPayloads(server)).toHaveLength(2);
  });

  it('surfaces a rejected request body as that repository failing, with the server message', async () => {
    await startServer((s) =>
      s
        .withGitlabRepos('my-gitlab', [gitlabRepo(11, 'group/repo-a')])
        .withBoundProjectFailure('11', 400, "personal access token for 'my-gitlab' is missing"),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('is missing');
  });

  it('explains a platform failure for one repository with the way to fix it', async () => {
    const server = await startServer((s) =>
      s
        .withGitlabRepos('my-gitlab', [gitlabRepo(11, 'group/repo-a')])
        .withBoundProjectFailure(
          '11',
          500,
          "Failed to fetch GitLab project with ID '11' from 'https://gitlab.example.com'",
        ),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(1);
    const output = result.stdout + result.stderr;
    expect(output).toContain('GitLab could not return the repository');
    expect(output).toContain(`${server.baseUrl()}/projects/create?mode=gitlab&resetPat=1`);
  });

  it('explains a project key that already exists with a different name', async () => {
    await startServer((s) =>
      s
        .withGitlabRepos('my-gitlab', [gitlabRepo(11, 'group/repo-a')])
        .withBoundProjectFailure(
          '11',
          400,
          "Project with key 'group_repo-a' cannot be bound - configuration mismatch",
        ),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      "project key 'group_repo-a' already exists with a different name; the CLI did not change it",
    );
  });

  it('falls back to POST when the server has no PUT on bound-projects', async () => {
    const server = await startServer((s) =>
      s
        .withGitlabRepos('my-gitlab', [
          gitlabRepo(11, 'group/repo-a'),
          gitlabRepo(12, 'group/repo-b'),
        ])
        .withoutBoundProjectsPut(405),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 2 repositories');
    const requests = server
      .getRecordedRequests()
      .filter((r) => r.path === '/api/v2/dop-translation/bound-projects');
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(2);
  });

  it('pages through every repository', async () => {
    const repos = Array.from({ length: 120 }, (_, i) => gitlabRepo(1000 + i, `group/repo-${i}`));
    const server = await startServer((s) => s.withGitlabRepos('my-gitlab', repos));

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 120 repositories');
    expect(putPayloads(server)).toHaveLength(120);
    const searches = server
      .getRecordedRequests()
      .filter((r) => r.path === '/api/alm_integrations/search_gitlab_repos');
    expect(searches.map((r) => r.query.p)).toEqual(['1', '2', '3']);
    expect(searches.every((r) => r.query.almSetting === 'my-gitlab' && r.query.ps === '50')).toBe(
      true,
    );
  });

  it('still stops at the token gate before listing any repository', async () => {
    const server = await startServer((s) =>
      s
        .withGitlabRepos('my-gitlab', [gitlabRepo(11, 'group/repo-a')])
        .withPatResponse('my-gitlab', {
          status: 400,
          message: "personal access token for 'my-gitlab' is missing",
        }),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(1);
    expect(
      server
        .getRecordedRequests()
        .some((r) => r.path === '/api/alm_integrations/search_gitlab_repos'),
    ).toBe(false);
  });
});
