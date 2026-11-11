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

// Integration tests for `sonar import --monorepo`, on SonarQube Cloud and SonarQube Server.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type FakeSonarQubeServer, TestHarness } from '../../harness';

const GITHUB_ALM = {
  key: 'github',
  url: 'https://github.com/my-org',
  personal: false,
  membersSync: false,
};
const GITLAB = { id: 'gl-id', key: 'my-gitlab', type: 'gitlab', url: 'https://gitlab.example.com' };

interface BoundProjectPayload {
  projectKey: string;
  projectName: string;
  repositoryIdentifier: string;
  monorepo: boolean;
}

describe('sonar import --monorepo', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe('SonarQube Cloud', () => {
    async function startCloud(
      configure: (server: ReturnType<TestHarness['newFakeServer']>) => void = () => {},
      repo: Record<string, unknown> = {},
    ): Promise<FakeSonarQubeServer> {
      const builder = harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withOrganizations([
          { key: 'my-org', name: 'My Org', alm: GITHUB_ALM, actions: { admin: true } },
        ])
        .withDopRepositories('my-org', [
          { id: 'repo-1', name: 'repo', slug: 'my-org/repo', ...repo },
        ]);
      configure(builder);
      const server = await builder.start();
      harness.withAuth(server.baseUrl(), 'test-token', 'my-org');
      return server;
    }

    function run(args: string, server: FakeSonarQubeServer) {
      return harness.run(`import ${args}`, {
        extraEnv: { SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl() },
      });
    }

    it(
      'binds every project to the repository in one batch call, skipping Autoscan',
      async () => {
        const server = await startCloud();

        const result = await run(
          '--monorepo my-org/repo --project my-org_repo_api,my-org_repo_web=Web',
          server,
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Bound 2 projects to my-org/repo');
        expect(result.stdout).toContain('/project/overview?id=my-org_repo_api');
        expect(result.stdout).toContain('/project/overview?id=my-org_repo_web');
        const recorded = server.getRecordedRequests();
        const batches = recorded.filter(
          (r) => r.path === '/api/alm_integration/provision_monorepo_projects',
        );
        expect(batches).toHaveLength(1);
        expect(JSON.parse(batches[0].body ?? '{}')).toEqual({
          organization: 'my-org',
          projects: [
            {
              projectKey: 'my-org_repo_api',
              projectName: 'my-org_repo_api',
              installationKey: 'my-org/repo|repo-1',
            },
            {
              projectKey: 'my-org_repo_web',
              projectName: 'Web',
              installationKey: 'my-org/repo|repo-1',
            },
          ],
        });
        expect(recorded.some((r) => r.path === '/api/autoscan/eligibility')).toBe(false);
        expect(recorded.some((r) => r.path === '/api/alm_integration/provision_projects')).toBe(
          false,
        );
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 1 and names the refused project when only part of the batch is created',
      async () => {
        const server = await startCloud((s) =>
          s.withMonorepoProvisionRefusal('my-org_repo_web', 'Key already exists'),
        );

        const result = await run(
          '--monorepo my-org/repo --project my-org_repo_api --project my-org_repo_web',
          server,
        );

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).toContain('Key already exists');
        expect(output).toContain('Bound 1 of 2 projects to my-org/repo (1 failed)');
        // The project that was bound keeps its link; the refused one gets none.
        expect(output).toContain('/project/overview?id=my-org_repo_api');
        expect(output).not.toContain('/project/overview?id=my-org_repo_web');
      },
      { timeout: 15000 },
    );

    it(
      'aborts without creating anything when the existing-project lookup fails',
      async () => {
        const server = await startCloud((s) => s.withComponentShowStatus(500));

        const result = await run('--monorepo my-org/repo --project my-org_repo_api', server);

        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain('Bound');
        expect(
          server
            .getRecordedRequests()
            .some((r) => r.path === '/api/alm_integration/provision_monorepo_projects'),
        ).toBe(false);
      },
      { timeout: 15000 },
    );

    function boundTo(...keys: string[]) {
      return { boundProjectIds: keys.map((key) => `id-${key}`), importedInCurrentOrg: true };
    }

    function batchKeys(server: FakeSonarQubeServer): string[] {
      return server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/alm_integration/provision_monorepo_projects')
        .flatMap((r) =>
          (JSON.parse(r.body ?? '{}') as { projects: Array<{ projectKey: string }> }).projects.map(
            (p) => p.projectKey,
          ),
        );
    }

    it(
      'warns about every project bound to the repository and skips the keys that exist',
      async () => {
        const server = await startCloud(
          (s) => s.withProject('my-org_repo_web').withProject('my-org_repo_docs'),
          {
            boundProjectIds: ['id-my-org_repo_web', 'id-my-org_repo_docs', 'id-in-another-org'],
            importedInCurrentOrg: true,
          },
        );

        const result = await run(
          '--monorepo my-org/repo --project my-org_repo_api,my-org_repo_web',
          server,
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain(
          '2 projects already bound to my-org/repo: my-org_repo_web, my-org_repo_docs',
        );
        expect(result.stderr).toContain('1 more project bound to my-org/repo not visible');
        expect(result.stderr).toContain(
          '1 requested project already exists and will be skipped: my-org_repo_web',
        );
        expect(result.stdout).toContain('Skipped (already exist): my-org_repo_web');
        expect(result.stdout).toContain('Bound 1 project to my-org/repo (1 skipped)');
        expect(batchKeys(server)).toEqual(['my-org_repo_api']);
      },
      { timeout: 15000 },
    );

    it(
      'creates nothing and succeeds when every project key already exists',
      async () => {
        const server = await startCloud(
          (s) => s.withProject('my-org_repo_api'),
          boundTo('my-org_repo_api'),
        );

        const result = await run('--monorepo my-org/repo --project my-org_repo_api', server);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Nothing to import');
        expect(batchKeys(server)).toEqual([]);
      },
      { timeout: 15000 },
    );

    it(
      'reports a key taken by a project bound elsewhere as a failure, not as already imported',
      async () => {
        const server = await startCloud(
          (s) =>
            s
              .withProject('my-org_repo_api')
              .withMonorepoProvisionRefusal('my-org_repo_api', 'Project key already exists'),
          boundTo('my-org_repo_docs'),
        );

        const result = await run('--monorepo my-org/repo --project my-org_repo_api', server);

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).not.toContain('Nothing to import');
        expect(output).toContain('exists but is not bound to my-org/repo');
        expect(output).toContain('Project key already exists');
        expect(batchKeys(server)).toEqual(['my-org_repo_api']);
      },
      { timeout: 15000 },
    );

    it(
      'asks before creating the remaining projects and creates nothing when declined',
      async () => {
        const server = await startCloud(
          (s) => s.withProject('my-org_repo_web'),
          boundTo('my-org_repo_web'),
        );

        const session = harness.runInteractive(
          'import --monorepo my-org/repo --project my-org_repo_api,my-org_repo_web',
          {
            extraEnv: {
              SONARQUBE_CLI_SONARCLOUD_URL: server.baseUrl(),
              CI: 'false',
              SONARQUBE_CLI_MOCK_TTY: '1',
            },
          },
        );
        await session.decline('Import the other 1 project (my-org_repo_api)?');
        const result = await session.waitFinish();

        expect(result.exitCode).toBe(1);
        expect(batchKeys(server)).toEqual([]);
      },
      { timeout: 15000 },
    );

    it(
      'exits with code 2 before any request when --monorepo has no project',
      async () => {
        const server = await startCloud();

        const result = await run('--monorepo my-org/repo', server);

        expect(result.exitCode).toBe(2);
        expect(result.stdout + result.stderr).toContain('at least one project');
        expect(server.getRecordedRequests().filter((r) => r.path.startsWith('/api/'))).toHaveLength(
          0,
        );
      },
      { timeout: 15000 },
    );
  });

  describe('SonarQube Server', () => {
    function gitlabRepo(extra: Record<string, unknown> = {}) {
      return {
        id: 11,
        name: 'repo',
        pathName: 'group',
        slug: 'repo',
        pathSlug: 'group',
        url: 'https://gitlab.example.com/group/repo',
        ...extra,
      };
    }

    async function startServer(repo = gitlabRepo()): Promise<FakeSonarQubeServer> {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withDopSettings([GITLAB])
        .withGitlabRepos('my-gitlab', [repo])
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');
      return server;
    }

    function payloads(server: FakeSonarQubeServer): BoundProjectPayload[] {
      return server
        .getRecordedRequests()
        .filter((r) => r.path === '/api/v2/dop-translation/bound-projects' && r.method === 'POST')
        .map((r) => JSON.parse(r.body ?? '{}') as BoundProjectPayload);
    }

    it(
      'creates one monorepo-flagged bound project per key, all on the same repository',
      async () => {
        const server = await startServer();

        const result = await harness.run(
          'import --monorepo group/repo --project group_repo_api=API --project group_repo_web',
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Bound 2 projects to group/repo');
        expect(result.stdout).toContain('/project/overview?id=group_repo_api');
        expect(result.stdout).toContain('/project/overview?id=group_repo_web');
        expect(
          payloads(server).map(({ projectKey, projectName, repositoryIdentifier, monorepo }) => ({
            projectKey,
            projectName,
            repositoryIdentifier,
            monorepo,
          })),
        ).toEqual([
          {
            projectKey: 'group_repo_api',
            projectName: 'API',
            repositoryIdentifier: '11',
            monorepo: true,
          },
          {
            projectKey: 'group_repo_web',
            projectName: 'group_repo_web',
            repositoryIdentifier: '11',
            monorepo: true,
          },
        ]);
      },
      { timeout: 15000 },
    );

    it(
      'adds projects to a repository that already has a bound project, skipping keys that exist',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopSettings([GITLAB])
          .withGitlabRepos('my-gitlab', [gitlabRepo({ sqProjectKey: 'group_repo' })])
          .withProject('group_repo_web')
          .withProjectBindings([
            { projectKey: 'group_repo_web', repository: '11', dopSettingId: 'gl-id' },
            { projectKey: 'group_repo_docs', repository: '11', dopSettingId: 'gl-id' },
            { projectKey: 'other_repo', repository: '12', dopSettingId: 'gl-id' },
          ])
          .start();
        harness.withAuth(server.baseUrl(), 'test-token');

        const result = await harness.run(
          'import --monorepo group/repo --project group_repo_api,group_repo_web',
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain(
          '2 projects already bound to group/repo: group_repo_web, group_repo_docs',
        );
        expect(result.stderr).not.toContain('other_repo');
        expect(result.stderr).toContain('already exists and will be skipped: group_repo_web');
        expect(result.stdout).toContain('Skipped (already exist): group_repo_web');
        expect(payloads(server).map(({ projectKey }) => projectKey)).toEqual(['group_repo_api']);
      },
      { timeout: 15000 },
    );

    it(
      'reports a key taken by a project bound to another repository as a failure',
      async () => {
        const server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withDopSettings([GITLAB])
          .withGitlabRepos('my-gitlab', [gitlabRepo({ sqProjectKey: 'group_repo' })])
          .withProject('group_repo_web')
          .withProjectBindings([
            { projectKey: 'group_repo_web', repository: '12', dopSettingId: 'gl-id' },
          ])
          .start();
        harness.withAuth(server.baseUrl(), 'test-token');

        const result = await harness.run(
          'import --monorepo group/repo --project group_repo_api,group_repo_web',
        );

        expect(result.exitCode).toBe(1);
        const output = result.stdout + result.stderr;
        expect(output).not.toContain('Skipped (already exist)');
        expect(output).toContain('is not bound to group/repo');
        expect(output).toContain('Bound 1 of 2 projects to group/repo (1 failed)');
        expect(payloads(server).map(({ projectKey }) => projectKey)).toEqual(['group_repo_api']);
      },
      { timeout: 15000 },
    );
  });
});
