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

function listerOver(repositories: AzureRepositoryResponse[]) {
  const searchAzureRepos = mock((_key: string) => Promise.resolve(repositories));
  const api = { searchAzureRepos } as unknown as ServerImportApiClient;
  return { fetch: azureSupport.listRepositories(api, SETTING), searchAzureRepos };
}

describe('azureSupport.listRepositories', () => {
  it('searches the repositories of every project in one request, without a project filter', async () => {
    const { fetch, searchAzureRepos } = listerOver([repo('Alpha', 'a1'), repo('Beta', 'b1')]);
    await fetch(1, 50);
    expect(searchAzureRepos.mock.calls).toEqual([['my-azure']]);
  });

  it('maps a repository to project/repository, identified by name within its project', async () => {
    const { fetch } = listerOver([repo('My Project', 'web-app')]);
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
    const { fetch } = listerOver([repo('A', 'api'), repo('B', 'api')]);
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.id)).toEqual(['A/api', 'B/api']);
    expect(repositories.map((r) => r.projectIdentifier)).toEqual(['A', 'B']);
  });

  it('carries the key of the project a repository is already bound to', async () => {
    const { fetch } = listerOver([
      repo('A', 'a1', { sqProjectKey: 'A_a1', sqProjectName: 'a1' }),
      repo('A', 'a2', { sqProjectKey: '' }),
      repo('A', 'a3'),
    ]);
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.boundProjectKey)).toEqual(['A_a1', undefined, undefined]);
  });

  it('is empty when the token sees no repository', async () => {
    const { fetch } = listerOver([]);
    expect(await fetch(1, 50)).toEqual({ repositories: [], total: 0 });
  });

  it('cuts the repositories into pages, a short page being the last', async () => {
    const { fetch } = listerOver(
      Array.from({ length: 8 }, (_, i) => repo(i < 3 ? 'A' : 'B', `r${i}`)),
    );

    const pages = [await fetch(1, 3), await fetch(2, 3), await fetch(3, 3)];

    expect(pages.map((p) => p.repositories.map((r) => r.name))).toEqual([
      ['r0', 'r1', 'r2'],
      ['r3', 'r4', 'r5'],
      ['r6', 'r7'],
    ]);
    expect(pages.map((p) => p.total)).toEqual([8, 8, 8]);
  });

  it('returns an empty page after the last full one', async () => {
    const { fetch } = listerOver([repo('A', 'a1'), repo('A', 'a2')]);
    expect((await fetch(1, 2)).repositories).toHaveLength(2);
    expect((await fetch(2, 2)).repositories).toEqual([]);
  });

  it('does not ask the server again once everything is read', async () => {
    const { fetch, searchAzureRepos } = listerOver([
      repo('A', 'a1'),
      repo('A', 'a2'),
      repo('B', 'b1'),
    ]);
    await fetch(1, 2);
    await fetch(2, 2);
    expect(searchAzureRepos).toHaveBeenCalledTimes(1);
  });

  it('searches again when the request failed, then serves the same page', async () => {
    let attempts = 0;
    const searchAzureRepos = mock(() => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new Error('boom'))
        : Promise.resolve([repo('A', 'a1'), repo('A', 'a2'), repo('B', 'b1')]);
    });
    const api = { searchAzureRepos } as unknown as ServerImportApiClient;
    const fetch = azureSupport.listRepositories(api, SETTING);

    const failure = await fetch(1, 2).catch((e: unknown) => e);
    expect((failure as Error).message).toBe('boom');
    const first = await fetch(1, 2);
    const second = await fetch(2, 2);

    expect(first.repositories.map((r) => r.id)).toEqual(['A/a1', 'A/a2']);
    expect(second.repositories.map((r) => r.id)).toEqual(['B/b1']);
    expect(searchAzureRepos).toHaveBeenCalledTimes(2);
  });
});
