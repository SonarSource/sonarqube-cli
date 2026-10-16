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

import { describe, expect, it, mock } from 'bun:test';

import { azureSupport } from '@/commands/import/server/azure.ts';
import type {
  AzureRepositoryResponse,
  DopSetting,
  ServerImportApiClient,
} from '@/commands/import/server/server-import-api.ts';

const SETTING: DopSetting = { id: 'az-id', key: 'my-azure', type: 'azure' };

function repo(projectName: string, name: string, extra: Partial<AzureRepositoryResponse> = {}) {
  return { name, projectName, ...extra };
}

function listerOver(reposByProject: Record<string, AzureRepositoryResponse[]>) {
  const listAzureProjects = mock(() =>
    Promise.resolve(Object.keys(reposByProject).map((name) => ({ name }))),
  );
  const searchAzureRepos = mock((_key: string, projectName: string) =>
    Promise.resolve(reposByProject[projectName]),
  );
  const api = { listAzureProjects, searchAzureRepos } as unknown as ServerImportApiClient;
  return {
    fetch: azureSupport.listRepositories(api, SETTING),
    listAzureProjects,
    searchAzureRepos,
  };
}

describe('azureSupport.listRepositories', () => {
  it('lists the projects of the setting, then the repositories of each project in order', async () => {
    const { fetch, listAzureProjects, searchAzureRepos } = listerOver({
      Alpha: [repo('Alpha', 'a1')],
      Beta: [repo('Beta', 'b1')],
    });
    await fetch(1, 50);
    expect(listAzureProjects).toHaveBeenCalledWith('my-azure');
    expect(searchAzureRepos.mock.calls).toEqual([
      ['my-azure', 'Alpha'],
      ['my-azure', 'Beta'],
    ]);
  });

  it('maps a repository to project/repository, identified by name within its project', async () => {
    const { fetch } = listerOver({ 'My Project': [repo('My Project', 'web-app')] });
    expect(await fetch(1, 50)).toEqual({
      repositories: [
        {
          id: 'My Project/web-app',
          name: 'web-app',
          slug: 'My Project/web-app',
          repositoryIdentifier: 'web-app',
          projectIdentifier: 'My Project',
          boundProjectKey: undefined,
        },
      ],
      total: 1,
    });
  });

  it('keeps same-named repositories of different projects apart', async () => {
    const { fetch } = listerOver({ A: [repo('A', 'api')], B: [repo('B', 'api')] });
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.id)).toEqual(['A/api', 'B/api']);
    expect(repositories.map((r) => r.projectIdentifier)).toEqual(['A', 'B']);
  });

  it('carries the key of the project a repository is already bound to', async () => {
    const { fetch } = listerOver({
      A: [repo('A', 'a1', { sqProjectKey: 'A_a1', sqProjectName: 'a1' }), repo('A', 'a2')],
    });
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.boundProjectKey)).toEqual(['A_a1', undefined]);
  });

  it('is empty when the server has no project', async () => {
    const { fetch, searchAzureRepos } = listerOver({});
    expect(await fetch(1, 50)).toEqual({ repositories: [], total: 0 });
    expect(searchAzureRepos).not.toHaveBeenCalled();
  });

  it('is empty when the projects have no repository', async () => {
    const { fetch } = listerOver({ A: [], B: [] });
    expect(await fetch(1, 50)).toEqual({ repositories: [], total: 0 });
  });

  it('cuts the repositories of all projects into pages, a short page being the last', async () => {
    const names = (project: string, from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => repo(project, `r${from + i}`));
    const { fetch } = listerOver({
      A: names('A', 0, 3),
      Empty: [],
      B: names('B', 3, 8),
    });

    const pages = [await fetch(1, 3), await fetch(2, 3), await fetch(3, 3)];

    expect(pages.map((p) => p.repositories.map((r) => r.name))).toEqual([
      ['r0', 'r1', 'r2'],
      ['r3', 'r4', 'r5'],
      ['r6', 'r7'],
    ]);
    expect(pages.map((p) => p.total)).toEqual([8, 8, 8]);
  });

  it('returns an empty page after the last full one', async () => {
    const { fetch } = listerOver({ A: [repo('A', 'a1'), repo('A', 'a2')] });
    expect((await fetch(1, 2)).repositories).toHaveLength(2);
    expect((await fetch(2, 2)).repositories).toEqual([]);
  });

  it('does not ask the server again once everything is read', async () => {
    const { fetch, listAzureProjects, searchAzureRepos } = listerOver({
      A: [repo('A', 'a1'), repo('A', 'a2')],
      B: [repo('B', 'b1')],
    });
    await fetch(1, 2);
    await fetch(2, 2);
    expect(listAzureProjects).toHaveBeenCalledTimes(1);
    expect(searchAzureRepos).toHaveBeenCalledTimes(2);
  });

  describe('when a request fails', () => {
    it('retries the page and skips nothing', async () => {
      const listAzureProjects = mock(() => Promise.resolve([{ name: 'A' }, { name: 'B' }]));
      let bAttempts = 0;
      const searchAzureRepos = mock((_key: string, projectName: string) => {
        bAttempts += projectName === 'B' ? 1 : 0;
        if (projectName === 'B' && bAttempts === 1) return Promise.reject(new Error('boom'));
        return Promise.resolve([
          repo(projectName, `${projectName}1`),
          repo(projectName, `${projectName}2`),
        ]);
      });
      const api = { listAzureProjects, searchAzureRepos } as unknown as ServerImportApiClient;
      const fetch = azureSupport.listRepositories(api, SETTING);

      const failure = await fetch(1, 3).catch((e: unknown) => e);
      expect((failure as Error).message).toBe('boom');
      const first = await fetch(1, 3);
      const second = await fetch(2, 3);

      expect(first.repositories.map((r) => r.id)).toEqual(['A/A1', 'A/A2', 'B/B1']);
      expect(second.repositories.map((r) => r.id)).toEqual(['B/B2']);
      expect(listAzureProjects).toHaveBeenCalledTimes(1);
      expect(searchAzureRepos.mock.calls.filter(([, project]) => project === 'A')).toHaveLength(1);
    });

    it('lists the projects again when that was what failed', async () => {
      let attempts = 0;
      const listAzureProjects = mock(() => {
        attempts++;
        return attempts === 1
          ? Promise.reject(new Error('boom'))
          : Promise.resolve([{ name: 'A' }]);
      });
      const searchAzureRepos = mock(() => Promise.resolve([repo('A', 'a1')]));
      const api = { listAzureProjects, searchAzureRepos } as unknown as ServerImportApiClient;
      const fetch = azureSupport.listRepositories(api, SETTING);

      const failure = await fetch(1, 50).catch((e: unknown) => e);
      expect((failure as Error).message).toBe('boom');
      expect((await fetch(1, 50)).repositories.map((r) => r.id)).toEqual(['A/a1']);
    });
  });
});
