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

import { bitbucketServerSupport } from '@/commands/import/server/bitbucket-server.ts';
import type {
  BitbucketServerRepositoryResponse,
  DopSetting,
  ServerImportApiClient,
} from '@/commands/import/server/server-import-api.ts';

const SETTING: DopSetting = { id: 'bb-id', key: 'my-bbs', type: 'bitbucket' };
const SERVER_PAGE_SIZE = 2;

type FakeRepo = Partial<BitbucketServerRepositoryResponse> & { slug: string };

function repoOf(projectKey: string, repo: FakeRepo): BitbucketServerRepositoryResponse {
  return { id: `${projectKey}-${repo.slug}`, name: `${repo.slug} name`, projectKey, ...repo };
}

function reposOf(projectKey: string, slugs: string[]): BitbucketServerRepositoryResponse[] {
  return slugs.map((slug) => repoOf(projectKey, { slug }));
}

/** A Bitbucket Server that serves `SERVER_PAGE_SIZE` repositories per request, whatever is asked. */
function serverOver(all: BitbucketServerRepositoryResponse[]) {
  const searchRepos = (_setting: string, start: number, _pageSize: number) => {
    const end = start + SERVER_PAGE_SIZE;
    return Promise.resolve({
      repositories: all.slice(start, end),
      nextStart: end < all.length ? end : undefined,
    });
  };
  const searchBitbucketServerRepos = mock(searchRepos);
  const api = { searchBitbucketServerRepos } as unknown as ServerImportApiClient;
  return {
    fetch: bitbucketServerSupport.listRepositories(api, SETTING),
    searchBitbucketServerRepos,
    searchRepos,
  };
}

describe('bitbucketServerSupport.listRepositories', () => {
  it('reports an empty server as an empty page with a zero total', async () => {
    const { fetch } = serverOver([]);
    expect(await fetch(1, 50)).toEqual({ repositories: [], total: 0 });
  });

  it('maps a repository to PROJECTKEY/slug with the identifiers the server expects', async () => {
    const { fetch } = serverOver([repoOf('PRJ', { slug: 'my-repo', name: 'My Repo', id: 77 })]);
    expect(await fetch(1, 50)).toEqual({
      repositories: [
        {
          id: '77',
          name: 'My Repo',
          slug: 'PRJ/my-repo',
          repositoryIdentifier: 'my-repo',
          projectIdentifier: 'PRJ',
          boundProjectKey: undefined,
        },
      ],
      total: 1,
    });
  });

  it('uses the project key of each repository, personal projects included', async () => {
    const { fetch } = serverOver([...reposOf('PRJ', ['a']), ...reposOf('~JDOE', ['b'])]);
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => [r.slug, r.projectIdentifier])).toEqual([
      ['PRJ/a', 'PRJ'],
      ['~JDOE/b', '~JDOE'],
    ]);
  });

  it('falls back to the full path as the id when the server sends none', async () => {
    const { fetch } = serverOver([repoOf('PRJ', { slug: 'repo', id: undefined })]);
    const { repositories } = await fetch(1, 50);
    expect(repositories[0].id).toBe('PRJ/repo');
  });

  it('carries the key of the SonarQube project a repository is already bound to', async () => {
    const { fetch } = serverOver([
      repoOf('PRJ', { slug: 'bound', sqProjectKey: 'PRJ_bound' }),
      repoOf('PRJ', { slug: 'free', sqProjectKey: '' }),
    ]);
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.boundProjectKey)).toEqual(['PRJ_bound', undefined]);
  });

  it('searches without a project filter, from offset 0, at the largest page size', async () => {
    const { fetch, searchBitbucketServerRepos } = serverOver(reposOf('A', ['a1']));
    await fetch(1, 50);
    expect(searchBitbucketServerRepos.mock.calls).toEqual([['my-bbs', 0, 100]]);
  });

  it('follows the offset the server hands out until the last page', async () => {
    const { fetch, searchBitbucketServerRepos } = serverOver(
      reposOf('A', ['a1', 'a2', 'a3', 'a4', 'a5']),
    );
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.slug)).toEqual(['A/a1', 'A/a2', 'A/a3', 'A/a4', 'A/a5']);
    expect(searchBitbucketServerRepos.mock.calls.map(([, start]) => start)).toEqual([0, 2, 4]);
  });

  it('cuts the repositories into flat pages independent of the server page size', async () => {
    const { fetch } = serverOver([
      ...reposOf('A', ['a1', 'a2', 'a3']),
      ...reposOf('C', ['c1']),
      ...reposOf('D', ['d1', 'd2', 'd3']),
    ]);

    const pages = [await fetch(1, 3), await fetch(2, 3), await fetch(3, 3)];

    expect(pages.map((p) => p.repositories.map((r) => r.slug))).toEqual([
      ['A/a1', 'A/a2', 'A/a3'],
      ['C/c1', 'D/d1', 'D/d2'],
      ['D/d3'],
    ]);
    expect(pages[2].total).toBe(7);
  });

  it('returns an empty page after a last page that was exactly full', async () => {
    const { fetch } = serverOver(reposOf('A', ['a1', 'a2']));
    expect((await fetch(1, 2)).repositories).toHaveLength(2);
    expect(await fetch(2, 2)).toEqual({ repositories: [], total: 2 });
  });

  it('stops fetching once a page is full', async () => {
    const { fetch, searchBitbucketServerRepos } = serverOver(
      reposOf('A', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']),
    );
    await fetch(1, 2);
    expect(searchBitbucketServerRepos).toHaveBeenCalledTimes(1);
  });

  describe('when a request fails', () => {
    it('resumes at the same page without skipping or repeating a repository', async () => {
      const { fetch, searchBitbucketServerRepos, searchRepos } = serverOver([
        ...reposOf('A', ['a1', 'a2', 'a3']),
        ...reposOf('B', ['b1', 'b2']),
      ]);
      searchBitbucketServerRepos.mockImplementationOnce(searchRepos);
      searchBitbucketServerRepos.mockImplementationOnce(() => Promise.reject(new Error('boom')));

      expect(await fetch(1, 3).catch((e: unknown) => e)).toEqual(new Error('boom'));
      const first = await fetch(1, 3);
      const second = await fetch(2, 3);

      expect(first.repositories.map((r) => r.slug)).toEqual(['A/a1', 'A/a2', 'A/a3']);
      expect(second.repositories.map((r) => r.slug)).toEqual(['B/b1', 'B/b2']);
    });

    it('retries the failed request from the same offset', async () => {
      const { fetch, searchBitbucketServerRepos, searchRepos } = serverOver([
        ...reposOf('A', ['a1', 'a2']),
        ...reposOf('B', ['b1']),
      ]);
      searchBitbucketServerRepos.mockImplementationOnce(searchRepos);
      searchBitbucketServerRepos.mockImplementationOnce(() => Promise.reject(new Error('boom')));

      expect(await fetch(1, 50).catch((e: unknown) => e)).toEqual(new Error('boom'));
      const { repositories } = await fetch(1, 50);

      expect(repositories.map((r) => r.slug)).toEqual(['A/a1', 'A/a2', 'B/b1']);
      expect(searchBitbucketServerRepos.mock.calls.map(([, start]) => start)).toEqual([0, 2, 2]);
    });

    it('does not lose the repositories fetched before the failure', async () => {
      const { fetch, searchBitbucketServerRepos, searchRepos } = serverOver([
        ...reposOf('A', ['a1', 'a2']),
        ...reposOf('B', ['b1']),
      ]);
      searchBitbucketServerRepos.mockImplementationOnce(searchRepos);
      searchBitbucketServerRepos.mockImplementationOnce(() => Promise.reject(new Error('boom')));

      expect(await fetch(1, 3).catch((e: unknown) => e)).toEqual(new Error('boom'));
      const { repositories } = await fetch(1, 3);

      expect(repositories.map((r) => r.slug)).toEqual(['A/a1', 'A/a2', 'B/b1']);
    });
  });
});
