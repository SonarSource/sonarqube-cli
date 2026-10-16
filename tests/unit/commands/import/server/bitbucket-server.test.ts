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

interface FakeProject {
  key: string;
  name: string;
  repos: Array<Partial<BitbucketServerRepositoryResponse> & { slug: string }>;
}

function project(key: string, repoSlugs: string[]): FakeProject {
  return { key, name: `Project ${key}`, repos: repoSlugs.map((slug) => ({ slug })) };
}

function fakeRepo(
  projectKey: string,
  repo: FakeProject['repos'][number],
): BitbucketServerRepositoryResponse {
  return { id: `${projectKey}-${repo.slug}`, name: `${repo.slug} name`, projectKey, ...repo };
}

/** A Bitbucket Server that serves `SERVER_PAGE_SIZE` items per request, whatever is asked. */
function serverOver(projects: FakeProject[]) {
  const listProjects = (_setting: string, start: number, _pageSize: number) => {
    const end = start + SERVER_PAGE_SIZE;
    return Promise.resolve({
      projects: projects.slice(start, end).map(({ key, name }) => ({ key, name })),
      nextStart: end < projects.length ? end : undefined,
    });
  };
  const searchRepos = (_setting: string, projectName: string, start: number, _pageSize: number) => {
    const matching = projects.filter((p) => p.name.includes(projectName));
    const all = matching.flatMap((p) => p.repos.map((repo) => fakeRepo(p.key, repo)));
    const end = start + SERVER_PAGE_SIZE;
    return Promise.resolve({
      repositories: all.slice(start, end),
      nextStart: end < all.length ? end : undefined,
    });
  };
  const listBitbucketServerProjects = mock(listProjects);
  const searchBitbucketServerRepos = mock(searchRepos);
  const api = {
    listBitbucketServerProjects,
    searchBitbucketServerRepos,
  } as unknown as ServerImportApiClient;
  return {
    fetch: bitbucketServerSupport.listRepositories(api, SETTING),
    listBitbucketServerProjects,
    searchBitbucketServerRepos,
    listProjects,
    searchRepos,
  };
}

describe('bitbucketServerSupport.listRepositories', () => {
  it('reports an empty server as an empty page with a zero total', async () => {
    const { fetch } = serverOver([]);
    expect(await fetch(1, 50)).toEqual({ repositories: [], total: 0 });
  });

  it('maps a repository to PROJECTKEY/slug with the identifiers the server expects', async () => {
    const { fetch } = serverOver([
      { key: 'PRJ', name: 'Project PRJ', repos: [{ slug: 'my-repo', name: 'My Repo', id: 77 }] },
    ]);
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

  it('falls back to the full path as the id when the server sends none', async () => {
    const { fetch } = serverOver([
      { key: 'PRJ', name: 'Project PRJ', repos: [{ slug: 'repo', id: undefined }] },
    ]);
    const { repositories } = await fetch(1, 50);
    expect(repositories[0].id).toBe('PRJ/repo');
  });

  it('carries the key of the SonarQube project a repository is already bound to', async () => {
    const { fetch } = serverOver([
      {
        key: 'PRJ',
        name: 'Project PRJ',
        repos: [
          { slug: 'bound', sqProjectKey: 'PRJ_bound' },
          { slug: 'free', sqProjectKey: '' },
        ],
      },
    ]);
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.boundProjectKey)).toEqual(['PRJ_bound', undefined]);
  });

  it('pages the project list by offset and lists each project by name from offset 0', async () => {
    const { fetch, listBitbucketServerProjects, searchBitbucketServerRepos } = serverOver([
      project('A', ['a1']),
      project('B', ['b1']),
      project('C', ['c1']),
    ]);
    await fetch(1, 50);
    expect(listBitbucketServerProjects.mock.calls.map(([, start]) => start)).toEqual([0, 2]);
    expect(listBitbucketServerProjects.mock.calls[0][0]).toBe('my-bbs');
    expect(searchBitbucketServerRepos.mock.calls.map(([, name, start]) => [name, start])).toEqual([
      ['Project A', 0],
      ['Project B', 0],
      ['Project C', 0],
    ]);
  });

  it('cuts the repositories of several projects into flat pages, the short one being last', async () => {
    const { fetch } = serverOver([
      project('A', ['a1', 'a2', 'a3']),
      project('B', []),
      project('C', ['c1']),
      project('D', ['d1', 'd2', 'd3']),
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
    const { fetch } = serverOver([project('A', ['a1', 'a2'])]);
    expect((await fetch(1, 2)).repositories).toHaveLength(2);
    expect(await fetch(2, 2)).toEqual({ repositories: [], total: 2 });
  });

  it('stops fetching once a page is full', async () => {
    const { fetch, listBitbucketServerProjects, searchBitbucketServerRepos } = serverOver([
      project('A', ['a1', 'a2', 'a3', 'a4']),
      project('B', ['b1']),
      project('C', ['c1']),
    ]);
    await fetch(1, 2);
    expect(searchBitbucketServerRepos).toHaveBeenCalledTimes(1);
    expect(listBitbucketServerProjects).toHaveBeenCalledTimes(1);
  });

  it('follows the repository offset of a project that needs several requests', async () => {
    const { fetch, searchBitbucketServerRepos } = serverOver([
      project('A', ['a1', 'a2', 'a3', 'a4', 'a5']),
    ]);
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.slug)).toEqual(['A/a1', 'A/a2', 'A/a3', 'A/a4', 'A/a5']);
    expect(searchBitbucketServerRepos.mock.calls.map(([, , start]) => start)).toEqual([0, 2, 4]);
  });

  it('keeps only the repositories of the project being listed when the name filter overmatches', async () => {
    const { fetch } = serverOver([
      { key: 'APP', name: 'App', repos: [{ slug: 'one' }] },
      { key: 'APP2', name: 'App 2', repos: [{ slug: 'two' }] },
    ]);
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.slug)).toEqual(['APP/one', 'APP2/two']);
  });

  describe('when a request fails', () => {
    it('resumes at the same page without skipping or repeating a repository', async () => {
      const { fetch, searchBitbucketServerRepos, searchRepos } = serverOver([
        project('A', ['a1', 'a2', 'a3']),
        project('B', ['b1', 'b2']),
      ]);
      searchBitbucketServerRepos.mockImplementationOnce(searchRepos);
      searchBitbucketServerRepos.mockImplementationOnce(() => Promise.reject(new Error('boom')));

      expect(await fetch(1, 3).catch((e: unknown) => e)).toEqual(new Error('boom'));
      const first = await fetch(1, 3);
      const second = await fetch(2, 3);

      expect(first.repositories.map((r) => r.slug)).toEqual(['A/a1', 'A/a2', 'A/a3']);
      expect(second.repositories.map((r) => r.slug)).toEqual(['B/b1', 'B/b2']);
    });

    it('retries the failed project list request from the same offset', async () => {
      const { fetch, listBitbucketServerProjects, listProjects } = serverOver([
        project('A', ['a1']),
        project('B', ['b1']),
        project('C', ['c1']),
      ]);
      listBitbucketServerProjects.mockImplementationOnce(listProjects);
      listBitbucketServerProjects.mockImplementationOnce(() => Promise.reject(new Error('boom')));

      expect(await fetch(1, 50).catch((e: unknown) => e)).toEqual(new Error('boom'));
      const { repositories } = await fetch(1, 50);

      expect(repositories.map((r) => r.slug)).toEqual(['A/a1', 'B/b1', 'C/c1']);
      expect(listBitbucketServerProjects.mock.calls.map(([, start]) => start)).toEqual([0, 2, 2]);
    });

    it('does not lose the repositories fetched before the failure', async () => {
      const { fetch, searchBitbucketServerRepos, searchRepos } = serverOver([
        project('A', ['a1', 'a2']),
        project('B', ['b1']),
      ]);
      searchBitbucketServerRepos.mockImplementationOnce(searchRepos);
      searchBitbucketServerRepos.mockImplementationOnce(() => Promise.reject(new Error('boom')));

      expect(await fetch(1, 3).catch((e: unknown) => e)).toEqual(new Error('boom'));
      const { repositories } = await fetch(1, 3);

      expect(repositories.map((r) => r.slug)).toEqual(['A/a1', 'A/a2', 'B/b1']);
    });
  });
});
