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

import { bitbucketCloudSupport } from '@/commands/import/server/bitbucket-cloud.ts';
import type {
  BitbucketCloudRepositoryResponse,
  DopSetting,
  ServerImportApiClient,
} from '@/commands/import/server/server-import-api.ts';

const SETTING: DopSetting = { id: 'bbc-id', key: 'my-bbc', type: 'bitbucketcloud' };

function repo(slug: string, extra: Partial<BitbucketCloudRepositoryResponse> = {}) {
  return { slug, uuid: `{${slug}-uuid}`, name: slug.toUpperCase(), workspace: 'acme', ...extra };
}

function listerOver(repositories: BitbucketCloudRepositoryResponse[]) {
  const searchBitbucketCloudRepos = mock(() => Promise.resolve({ repositories }));
  const api = { searchBitbucketCloudRepos } as unknown as ServerImportApiClient;
  return { fetch: bitbucketCloudSupport.listRepositories(api, SETTING), searchBitbucketCloudRepos };
}

describe('bitbucketCloudSupport.listRepositories', () => {
  it('asks the server for the requested page of the setting', async () => {
    const { fetch, searchBitbucketCloudRepos } = listerOver([]);
    await fetch(3, 50);
    expect(searchBitbucketCloudRepos).toHaveBeenCalledWith('my-bbc', 3, 50);
  });

  it('maps a repository to its workspace path, uuid and slug identifier', async () => {
    const { fetch } = listerOver([repo('repo-a', { name: 'Repo A' })]);
    expect((await fetch(1, 50)).repositories).toEqual([
      {
        id: '{repo-a-uuid}',
        name: 'Repo A',
        slug: 'acme/repo-a',
        repositoryIdentifier: 'repo-a',
        boundProjectKey: undefined,
      },
    ]);
  });

  it('never sends a projectIdentifier', async () => {
    const { fetch } = listerOver([repo('repo-a')]);
    expect((await fetch(1, 50)).repositories[0]).not.toHaveProperty('projectIdentifier');
  });

  it('carries the key of the project a repository is already bound to', async () => {
    const { fetch } = listerOver([
      repo('a', { sqProjectKey: 'acme_a' }),
      repo('b', { sqProjectKey: '' }),
      repo('c'),
    ]);
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.boundProjectKey)).toEqual(['acme_a', undefined, undefined]);
  });

  it('returns no repositories for an empty page', async () => {
    const { fetch } = listerOver([]);
    expect(await fetch(1, 50)).toEqual({ repositories: [], total: 0 });
  });

  it('counts the repositories of the earlier pages in the total', async () => {
    const { fetch } = listerOver([repo('a'), repo('b')]);
    expect((await fetch(3, 50)).total).toBe(102);
  });
});
