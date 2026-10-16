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

// Integration tests for importing Azure DevOps repositories with `sonar import` on SonarQube Server.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { type FakeSonarQubeServer, TestHarness } from '../../harness';

const AZURE = { id: 'az-id', key: 'my-azure', type: 'azure', url: 'https://dev.azure.com/org' };

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

describe('sonar import: Azure DevOps on SonarQube Server', () => {
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
    const builder = harness.newFakeServer().withAuthToken('test-token').withDopSettings([AZURE]);
    configure(builder);
    const server = await builder.start();
    harness.withAuth(server.baseUrl(), 'test-token');
    return server;
  }

  it('imports every repository of every Azure DevOps project with --all', async () => {
    const server = await startServer((s) =>
      s.withAzureRepos('my-azure', [
        { name: 'api', projectName: 'Project A' },
        { name: 'web', projectName: 'Project A' },
        { name: 'api', projectName: 'Project B' },
      ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Imported 3 repositories');
    expect(result.stdout).toContain(`Projects: ${server.baseUrl()}/projects`);
    const payloads = putPayloads(server);
    expect(payloads.map((p) => p.projectKey).sort()).toEqual([
      'Project_A_api',
      'Project_A_web',
      'Project_B_api',
    ]);
    const searches = server
      .getRecordedRequests()
      .filter((r) => r.path === '/api/alm_integration/search_azure_repos');
    expect(searches.map((r) => r.query.projectName).sort()).toEqual(['Project A', 'Project B']);
    expect(searches.every((r) => r.query.almSetting === 'my-azure')).toBe(true);
  });

  it('sends the repository name as repositoryIdentifier and the Azure project as projectIdentifier', async () => {
    const server = await startServer((s) =>
      s.withAzureRepos('my-azure', [{ name: 'web-app', projectName: 'My Project' }]),
    );

    const result = await harness.run('import --repo "My Project/web-app"');

    expect(result.exitCode).toBe(0);
    expect(putPayloads(server)).toEqual([
      {
        projectKey: 'My_Project_web-app',
        projectName: 'web-app',
        devOpsPlatformSettingId: 'az-id',
        repositoryIdentifier: 'web-app',
        projectIdentifier: 'My Project',
        monorepo: false,
      },
    ]);
  });

  it('skips repositories that are already bound to a project, without failing', async () => {
    const server = await startServer((s) =>
      s.withAzureRepos('my-azure', [
        { name: 'api', projectName: 'Project A', sqProjectKey: 'Project_A_api' },
        { name: 'web', projectName: 'Project A' },
      ]),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('already imported');
    expect(putPayloads(server).map((p) => p.repositoryIdentifier)).toEqual(['web']);
  });

  it('still stops at the token gate before listing any project', async () => {
    const server = await startServer((s) =>
      s
        .withAzureRepos('my-azure', [{ name: 'api', projectName: 'Project A' }])
        .withPatResponse('my-azure', {
          status: 400,
          message: "personal access token for 'my-azure' is missing",
        }),
    );

    const result = await harness.run('import --all');

    expect(result.exitCode).toBe(1);
    const listed = server
      .getRecordedRequests()
      .filter((r) => r.path.startsWith('/api/alm_integration/') && r.path.includes('azure'));
    expect(listed).toHaveLength(0);
    expect(putPayloads(server)).toHaveLength(0);
  });
});
