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

import { gitlabSupport } from '@/commands/import/server/gitlab.ts';
import type {
  DopSetting,
  GitlabRepositoryResponse,
  ServerImportApiClient,
} from '@/commands/import/server/server-import-api.ts';

const SETTING: DopSetting = { id: 'gl-id', key: 'my-gitlab', type: 'gitlab' };

function listerOver(repositories: GitlabRepositoryResponse[], total?: number) {
  const searchGitlabRepos = mock(() => Promise.resolve({ repositories, total }));
  const api = { searchGitlabRepos } as unknown as ServerImportApiClient;
  return { fetch: gitlabSupport.listRepositories(api, SETTING), searchGitlabRepos };
}

describe('gitlabSupport.listRepositories', () => {
  it('asks the server for the requested page of the setting', async () => {
    const { fetch, searchGitlabRepos } = listerOver([]);
    await fetch(3, 50);
    expect(searchGitlabRepos).toHaveBeenCalledWith('my-gitlab', 3, 50);
  });

  it('maps a project to a repository identified by its numeric id', async () => {
    const { fetch } = listerOver(
      [{ id: 42, name: 'Repo A', slug: 'repo-a', pathSlug: 'group/sub' }],
      7,
    );
    expect(await fetch(1, 50)).toEqual({
      repositories: [
        {
          id: '42',
          name: 'Repo A',
          slug: 'group/sub/repo-a',
          repositoryIdentifier: '42',
          boundProjectKey: undefined,
        },
      ],
      total: 7,
    });
  });

  it('uses the bare slug for a project outside any namespace path', async () => {
    const { fetch } = listerOver([{ id: '1', name: 'solo', slug: 'solo' }]);
    expect((await fetch(1, 50)).repositories[0].slug).toBe('solo');
  });

  it('carries the key of the project a repository is already bound to', async () => {
    const { fetch } = listerOver([
      { id: 1, name: 'a', slug: 'a', pathSlug: 'g', sqProjectKey: 'g_a' },
      { id: 2, name: 'b', slug: 'b', pathSlug: 'g', sqProjectKey: '' },
    ]);
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.boundProjectKey)).toEqual(['g_a', undefined]);
  });

  it('falls back to the page length when the server reports no total', async () => {
    const { fetch } = listerOver([{ id: 1, name: 'a', slug: 'a' }]);
    expect((await fetch(1, 50)).total).toBe(1);
  });
});
