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

import { githubSupport } from '@/commands/import/server/github.ts';
import type {
  DopSetting,
  GithubOrganizationResponse,
  GithubRepositoryResponse,
  ServerImportApiClient,
} from '@/commands/import/server/server-import-api.ts';

const SETTING: DopSetting = { id: 'gh-id', key: 'my-github', type: 'github' };
const SERVER_PAGE_SIZE = 100;

function repo(organization: string, name: string, extra: Partial<GithubRepositoryResponse> = {}) {
  return {
    id: `${organization}-${name}`,
    key: `${organization}/${name}`,
    name,
    ...extra,
  } satisfies GithubRepositoryResponse;
}

function repos(organization: string, count: number): GithubRepositoryResponse[] {
  return Array.from({ length: count }, (_, i) => repo(organization, `r${i}`));
}

/** Serves the organizations and their repositories the way the server pages them. */
function listerOver(
  organizations: string[],
  repositories: Record<string, GithubRepositoryResponse[]>,
) {
  const listGithubOrganizations = mock((_setting: string, pageIndex: number, pageSize: number) => {
    const all: GithubOrganizationResponse[] = organizations.map((key) => ({ key, name: key }));
    const start = (pageIndex - 1) * pageSize;
    return Promise.resolve({
      organizations: all.slice(start, start + pageSize),
      total: all.length,
    });
  });
  const listGithubRepositories = mock(
    (_setting: string, organization: string, pageIndex: number, pageSize: number) => {
      const all = repositories[organization] ?? [];
      const start = (pageIndex - 1) * pageSize;
      return Promise.resolve({
        repositories: all.slice(start, start + pageSize),
        total: all.length,
      });
    },
  );
  const api = {
    listGithubOrganizations,
    listGithubRepositories,
  } as unknown as ServerImportApiClient;
  return {
    fetch: githubSupport.listRepositories(api, SETTING),
    listGithubOrganizations,
    listGithubRepositories,
  };
}

const slugs = (page: { repositories: Array<{ slug: string }> }) =>
  page.repositories.map((r) => r.slug);

const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe('githubSupport.listRepositories', () => {
  it('lists the organizations of the setting, then the repositories of the first one', async () => {
    const { fetch, listGithubOrganizations, listGithubRepositories } = listerOver(['acme'], {
      acme: [repo('acme', 'a')],
    });
    await fetch(1, 50);
    expect(listGithubOrganizations).toHaveBeenCalledWith('my-github', 1, SERVER_PAGE_SIZE);
    expect(listGithubRepositories).toHaveBeenCalledWith('my-github', 'acme', 1, SERVER_PAGE_SIZE);
  });

  it('identifies a repository by its full name, which is what the server needs to import it', async () => {
    const { fetch } = listerOver(['acme'], {
      acme: [
        { id: 42, key: 'acme/widgets', name: 'widgets', url: 'https://github.com/acme/widgets' },
      ],
    });
    expect(await fetch(1, 50)).toEqual({
      repositories: [
        {
          id: '42',
          name: 'widgets',
          slug: 'acme/widgets',
          repositoryIdentifier: 'acme/widgets',
          boundProjectKey: undefined,
        },
      ],
      total: 1,
    });
  });

  it('carries the key of the project a repository is already bound to', async () => {
    const { fetch } = listerOver(['acme'], {
      acme: [
        repo('acme', 'a', { sqProjectKey: 'acme_a' }),
        repo('acme', 'b', { sqProjectKey: '' }),
        repo('acme', 'c'),
      ],
    });
    const { repositories } = await fetch(1, 50);
    expect(repositories.map((r) => r.boundProjectKey)).toEqual(['acme_a', undefined, undefined]);
  });

  it('returns an empty page when there is no organization', async () => {
    const { fetch, listGithubRepositories } = listerOver([], {});
    expect(await fetch(1, 50)).toEqual({ repositories: [], total: 0 });
    expect(listGithubRepositories).not.toHaveBeenCalled();
  });

  it('returns an empty page when the organizations have no repository', async () => {
    const { fetch } = listerOver(['empty-a', 'empty-b'], {});
    expect(await fetch(1, 50)).toEqual({ repositories: [], total: 0 });
  });

  it('continues into the next organization to fill a page', async () => {
    const { fetch, listGithubRepositories } = listerOver(['one', 'two'], {
      one: repos('one', 2),
      two: repos('two', 3),
    });
    const page = await fetch(1, 4);
    expect(slugs(page)).toEqual(['one/r0', 'one/r1', 'two/r0', 'two/r1']);
    expect(listGithubRepositories.mock.calls.map((call) => call[1])).toEqual(['one', 'two']);
  });

  it('serves the buffered repositories on the next page without asking again', async () => {
    const { fetch, listGithubRepositories } = listerOver(['one', 'two'], {
      one: repos('one', 2),
      two: repos('two', 3),
    });
    await fetch(1, 4);
    const calls = listGithubRepositories.mock.calls.length;

    const second = await fetch(2, 4);

    expect(slugs(second)).toEqual(['two/r2']);
    expect(listGithubRepositories.mock.calls).toHaveLength(calls);
  });

  it('ends with a page shorter than the page size, carrying the count of everything listed', async () => {
    const { fetch } = listerOver(['one'], { one: repos('one', 5) });
    const first = await fetch(1, 3);
    const second = await fetch(2, 3);
    expect(first.repositories).toHaveLength(3);
    expect(second.repositories).toHaveLength(2);
    expect(second.total).toBe(5);
  });

  it('ends with an empty page when the repositories fill the last page exactly', async () => {
    const { fetch } = listerOver(['one'], { one: repos('one', 4) });
    expect((await fetch(1, 2)).repositories).toHaveLength(2);
    expect((await fetch(2, 2)).repositories).toHaveLength(2);
    expect((await fetch(3, 2)).repositories).toEqual([]);
  });

  it('pages through an organization with more repositories than the server returns at once', async () => {
    const { fetch, listGithubRepositories } = listerOver(['big'], {
      big: repos('big', SERVER_PAGE_SIZE + 20),
    });
    const all = [...slugs(await fetch(1, 80)), ...slugs(await fetch(2, 80))];
    expect(all).toEqual(repos('big', SERVER_PAGE_SIZE + 20).map((r) => r.key));
    expect(listGithubRepositories.mock.calls.map((call) => call[2])).toEqual([1, 2]);
  });

  it('moves on without another request once the reported total has been reached', async () => {
    const { fetch, listGithubRepositories } = listerOver(['exact', 'next'], {
      exact: repos('exact', SERVER_PAGE_SIZE),
      next: repos('next', 1),
    });
    const page = await fetch(1, SERVER_PAGE_SIZE + 1);
    expect(page.repositories).toHaveLength(SERVER_PAGE_SIZE + 1);
    expect(listGithubRepositories.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['exact', 1],
      ['next', 1],
    ]);
  });

  it('pages through the organizations too', async () => {
    const lastOrganization = `org${SERVER_PAGE_SIZE}`;
    const organizations = Array.from({ length: SERVER_PAGE_SIZE + 1 }, (_, i) => `org${i}`);
    const { fetch, listGithubOrganizations } = listerOver(organizations, {
      org0: [repo('org0', 'a')],
      [lastOrganization]: [repo(lastOrganization, 'z')],
    });
    const page = await fetch(1, 50);
    expect(slugs(page)).toEqual(['org0/a', `${lastOrganization}/z`]);
    expect(listGithubOrganizations.mock.calls.map((call) => call[1])).toEqual([1, 2]);
  });

  it('retries the same page after the organizations failed to load', async () => {
    const { fetch, listGithubOrganizations } = listerOver(['one'], { one: repos('one', 2) });
    listGithubOrganizations.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    expect(await failureOf(fetch(1, 50))).toBe('boom');

    expect(slugs(await fetch(1, 50))).toEqual(['one/r0', 'one/r1']);
  });

  it('retries the same page after a repository listing failed, without skipping data', async () => {
    const { fetch, listGithubRepositories } = listerOver(['one', 'two'], {
      one: repos('one', 2),
      two: repos('two', 2),
    });
    listGithubRepositories.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    expect(await failureOf(fetch(1, 3))).toBe('boom');

    const first = await fetch(1, 3);
    const second = await fetch(2, 3);

    expect([...slugs(first), ...slugs(second)]).toEqual(['one/r0', 'one/r1', 'two/r0', 'two/r1']);
  });

  it('keeps what an earlier request fetched when a later one for the same page fails', async () => {
    const { fetch, listGithubRepositories } = listerOver(['one', 'two'], {
      one: repos('one', 2),
      two: repos('two', 2),
    });
    listGithubRepositories.mockImplementationOnce(() =>
      Promise.resolve({ repositories: repos('one', 2), total: 2 }),
    );
    listGithubRepositories.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    expect(await failureOf(fetch(1, 3))).toBe('boom');
    const page = await fetch(1, 3);

    expect(slugs(page)).toEqual(['one/r0', 'one/r1', 'two/r0']);
    expect(listGithubRepositories.mock.calls.filter((call) => call[1] === 'one')).toHaveLength(1);
  });

  it('fails the page when an organization keeps failing, instead of returning partial data', async () => {
    const { fetch, listGithubRepositories } = listerOver(['one'], { one: repos('one', 2) });
    listGithubRepositories.mockImplementation(() => Promise.reject(new Error('rate limited')));

    expect(await failureOf(fetch(1, 50))).toBe('rate limited');
    expect(await failureOf(fetch(1, 50))).toBe('rate limited');
  });
});
