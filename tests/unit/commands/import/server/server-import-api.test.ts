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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ServerImportApiClient } from '@/commands/import/server/server-import-api.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import {
  AccessDeniedError,
  BadRequestError,
  ServerError,
  UnexpectedApiError,
} from '@/core/server/errors.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';

import {
  fakeResponse,
  lastFetchInit,
  lastFetchUrl,
  mockFetch,
  mockFetchSeq,
} from '../../../helpers/mock-fetch.ts';

const SERVER_URL = 'https://sonarqube.example.com';

/** A 204 as `fetch` returns it: ok, with a body that is not JSON. */
function noContentResponse(): Response {
  return {
    ok: true,
    status: 204,
    statusText: 'No Content',
    json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    text: () => Promise.resolve(''),
    headers: new Headers(),
  } as Response;
}

function badRequest(message: string): Response {
  return fakeResponse({ errors: [{ msg: message }] }, { status: 400 });
}

describe('ServerImportApiClient', () => {
  let api: ServerImportApiClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    api = new ServerImportApiClient(new SonarHttpClient(SERVER_URL, 'squ_token'), SERVER_URL);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe('listDopSettings', () => {
    it('calls the v2 dop-settings endpoint', async () => {
      fetchSpy = mockFetch({ dopSettings: [] });
      await api.listDopSettings();
      expect(new URL(lastFetchUrl(fetchSpy)).pathname).toBe('/api/v2/dop-translation/dop-settings');
    });

    it('maps settings of every supported platform', async () => {
      fetchSpy = mockFetch({
        dopSettings: [
          { id: '1', key: 'gh', type: 'github', url: 'https://api.github.com', appId: 'x' },
          { id: '2', key: 'gl', type: 'gitlab', url: 'https://gitlab.com' },
          { id: '3', key: 'az', type: 'azure', url: 'https://dev.azure.com/org' },
          { id: '4', key: 'bbs', type: 'bitbucket', url: 'https://bbs.example.com' },
          { id: '5', key: 'bbc', type: 'bitbucketcloud', url: null },
        ],
      });
      expect(await api.listDopSettings()).toEqual([
        { id: '1', key: 'gh', type: 'github', url: 'https://api.github.com' },
        { id: '2', key: 'gl', type: 'gitlab', url: 'https://gitlab.com' },
        { id: '3', key: 'az', type: 'azure', url: 'https://dev.azure.com/org' },
        { id: '4', key: 'bbs', type: 'bitbucket', url: 'https://bbs.example.com' },
        { id: '5', key: 'bbc', type: 'bitbucketcloud' },
      ]);
    });

    it('leaves out platforms the CLI does not know', async () => {
      fetchSpy = mockFetch({
        dopSettings: [
          { id: '1', key: 'future', type: 'somethingnew', url: 'https://x.example.com' },
          { id: '2', key: 'gl', type: 'gitlab', url: 'https://gitlab.com' },
        ],
      });
      const settings = await api.listDopSettings();
      expect(settings.map((s) => s.key)).toEqual(['gl']);
    });

    it('returns an empty list when nothing is configured', async () => {
      fetchSpy = mockFetch({ dopSettings: [] });
      expect(await api.listDopSettings()).toEqual([]);
    });

    it('rejects when the endpoint is missing (older server)', async () => {
      fetchSpy = mockFetch({}, { status: 404 });
      const error = await api.listDopSettings().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect((error as AccessDeniedError).status).toBe(404);
    });
  });

  describe.each([
    ['checkPat', '/api/alm_integrations/check_pat'],
    ['probeGithubPat', '/api/alm_integrations/list_github_organizations'],
  ] as const)('%s', (method, path) => {
    const statusOf = async (key: string) => {
      const result = await api[method](key);
      return typeof result === 'string' ? result : result.status;
    };

    it('sends the setting key as almSetting, and nothing token-like', async () => {
      fetchSpy = mockFetchSeq(noContentResponse());
      await api[method]('my-setting');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe(path);
      expect([...url.searchParams.keys()]).toEqual(['almSetting']);
      expect(url.searchParams.get('almSetting')).toBe('my-setting');
      expect(lastFetchInit(fetchSpy).method).toBe('GET');
    });

    it('is valid on an empty 2xx', async () => {
      fetchSpy = mockFetchSeq(noContentResponse());
      expect(await statusOf('s')).toBe('valid');
    });

    it('is valid on a JSON 200', async () => {
      fetchSpy = mockFetch({ organizations: [] });
      expect(await statusOf('s')).toBe('valid');
    });

    it('is missing when the server says the token is missing', async () => {
      fetchSpy = mockFetchSeq(badRequest("personal access token for 's' is missing"));
      expect(await statusOf('s')).toBe('missing');
    });

    it('is missing for the GitLab capitalisation', async () => {
      fetchSpy = mockFetchSeq(badRequest("Personal access token for 's' Is Missing"));
      expect(await statusOf('s')).toBe('missing');
    });

    it('is invalid when the platform rejects the token', async () => {
      fetchSpy = mockFetchSeq(badRequest('Invalid personal access token'));
      expect(await statusOf('s')).toBe('invalid');
    });

    it('rejects with the server message on a 400 that is not about the token', async () => {
      fetchSpy = mockFetchSeq(badRequest('Unable to contact Bitbucket server'));
      const error = await statusOf('s').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestError);
      expect((error as BadRequestError).message).toBe('Unable to contact Bitbucket server');
    });

    it('rejects with the original error when the status is not about the token', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 403 }));
      const error = await statusOf('s').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AccessDeniedError);
      expect((error as AccessDeniedError).status).toBe(403);
    });

    it('rejects on a server error rather than calling the token invalid', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 500 }));
      const error = await statusOf('s').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
    });
  });

  describe('query encoding', () => {
    it.each([
      ['checkPat', (c: ServerImportApiClient) => c.checkPat('My stuff here')],
      ['probeGithubPat', (c: ServerImportApiClient) => c.probeGithubPat('My stuff here')],
    ] as const)('%s sends a key with spaces as %%20, not +', async (_name, call) => {
      fetchSpy = mockFetchSeq(noContentResponse());
      await call(api);
      const url = lastFetchUrl(fetchSpy);
      expect(url).toContain('almSetting=My%20stuff%20here');
      expect(url).not.toContain('+');
    });

    it('also escapes reserved characters in a key', async () => {
      fetchSpy = mockFetchSeq(noContentResponse());
      await api.checkPat('a&b=c/d');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.searchParams.get('almSetting')).toBe('a&b=c/d');
      expect([...url.searchParams.keys()]).toEqual(['almSetting']);
    });
  });

  describe('searchGitlabRepos', () => {
    it('sends the setting key and paging as almSetting, p and ps', async () => {
      fetchSpy = mockFetch({ repositories: [], paging: { total: 0 } });
      await api.searchGitlabRepos('my-gitlab', 2, 50);
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/alm_integrations/search_gitlab_repos');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        almSetting: 'my-gitlab',
        p: '2',
        ps: '50',
      });
    });

    it('returns the repositories and the reported total', async () => {
      fetchSpy = mockFetch({
        repositories: [{ id: 1, name: 'a', slug: 'a', pathSlug: 'g', sqProjectKey: 'g_a' }],
        paging: { pageIndex: 1, pageSize: 50, total: 9 },
      });
      expect(await api.searchGitlabRepos('s', 1, 50)).toEqual({
        repositories: [{ id: 1, name: 'a', slug: 'a', pathSlug: 'g', sqProjectKey: 'g_a' }],
        total: 9,
      });
    });

    it('treats an empty result as no repositories and no total', async () => {
      fetchSpy = mockFetch({});
      expect(await api.searchGitlabRepos('s', 1, 50)).toEqual({
        repositories: [],
        total: undefined,
      });
    });

    it('rejects on a 400 such as a missing token', async () => {
      fetchSpy = mockFetchSeq(badRequest('No personal access token found'));
      const error = await api.searchGitlabRepos('s', 1, 50).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestError);
    });
  });

  describe('searchAzureRepos', () => {
    it('sends the setting key as almSetting, with no project filter', async () => {
      fetchSpy = mockFetch({ repositories: [] });
      await api.searchAzureRepos('my-azure');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/alm_integrations/search_azure_repos');
      expect(Object.fromEntries(url.searchParams)).toEqual({ almSetting: 'my-azure' });
    });

    it('returns the repositories with their project and the SonarQube project they are bound to', async () => {
      const repositories = [
        { name: 'r1', projectName: 'p1', sqProjectKey: 'p1_r1', sqProjectName: 'r1' },
        { name: 'r2', projectName: 'p1' },
      ];
      fetchSpy = mockFetch({ repositories });
      expect(await api.searchAzureRepos('s')).toEqual(repositories);
    });

    it('treats a response without repositories as an empty list', async () => {
      fetchSpy = mockFetch({});
      expect(await api.searchAzureRepos('s')).toEqual([]);
    });

    it('rejects on a 400 such as a missing token', async () => {
      fetchSpy = mockFetchSeq(badRequest('No personal access token found'));
      const error = await api.searchAzureRepos('s').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestError);
    });
  });

  describe('searchBitbucketCloudRepos', () => {
    it('sends the setting key and paging as almSetting, p and ps', async () => {
      fetchSpy = mockFetch({ repositories: [], isLastPage: true });
      await api.searchBitbucketCloudRepos('my-bbc', 2, 50);
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/alm_integrations/search_bitbucketcloud_repos');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        almSetting: 'my-bbc',
        p: '2',
        ps: '50',
      });
    });

    it('returns the repositories as the server sends them', async () => {
      const repository = {
        slug: 'repo-a',
        uuid: '{uuid-a}',
        name: 'Repo A',
        workspace: 'acme',
        projectKey: 'PRJ',
        sqProjectKey: 'acme_repo-a',
      };
      fetchSpy = mockFetch({
        paging: { pageIndex: 1, pageSize: 50 },
        isLastPage: false,
        repositories: [repository],
      });
      expect(await api.searchBitbucketCloudRepos('s', 1, 50)).toEqual({
        repositories: [repository],
      });
    });

    it('treats an empty result as no repositories', async () => {
      fetchSpy = mockFetch({});
      expect(await api.searchBitbucketCloudRepos('s', 1, 50)).toEqual({ repositories: [] });
    });

    it('rejects on a 400 such as a missing token', async () => {
      fetchSpy = mockFetchSeq(badRequest('No personal access token found'));
      const error = await api.searchBitbucketCloudRepos('s', 1, 50).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestError);
    });
  });

  describe('searchBitbucketServerRepos', () => {
    it('sends the setting key, start offset and page size, with no project filter', async () => {
      fetchSpy = mockFetch({ repositories: [], isLastPage: true });
      await api.searchBitbucketServerRepos('my-bbs', 50, 100);
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/alm_integrations/search_bitbucketserver_repos');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        almSetting: 'my-bbs',
        start: '50',
        pageSize: '100',
      });
    });

    it('returns the repositories and where the next page starts', async () => {
      const repositories = [
        { id: 5, slug: 'repo', name: 'Repo', projectKey: 'PRJ', projectName: 'Project' },
        { id: 6, slug: 'bound', name: 'Bound', projectKey: 'PRJ', sqProjectKey: 'PRJ_bound' },
      ];
      fetchSpy = mockFetch({ repositories, isLastPage: false, nextPageStart: 2 });
      expect(await api.searchBitbucketServerRepos('s', 0, 100)).toEqual({
        repositories,
        nextStart: 2,
      });
    });

    it('has no next page on the last one', async () => {
      fetchSpy = mockFetch({ repositories: [], isLastPage: true });
      expect((await api.searchBitbucketServerRepos('s', 0, 100)).nextStart).toBeUndefined();
    });

    it('has no next page when the offset would not advance', async () => {
      fetchSpy = mockFetch({ repositories: [], isLastPage: false, nextPageStart: 25 });
      expect((await api.searchBitbucketServerRepos('s', 25, 100)).nextStart).toBeUndefined();
    });

    it('treats an empty result as no repositories', async () => {
      fetchSpy = mockFetch({});
      expect(await api.searchBitbucketServerRepos('s', 0, 100)).toEqual({
        repositories: [],
        nextStart: undefined,
      });
    });

    it('rejects on a server error', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 500 }));
      const error = await api.searchBitbucketServerRepos('s', 0, 100).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
    });
  });

  describe('listGithubOrganizations', () => {
    it('sends the setting key and paging as almSetting, p and ps', async () => {
      fetchSpy = mockFetch({ organizations: [], paging: { total: 0 } });
      await api.listGithubOrganizations('my-github', 2, 100);
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/alm_integrations/list_github_organizations');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        almSetting: 'my-github',
        p: '2',
        ps: '100',
      });
      expect(lastFetchInit(fetchSpy).method).toBe('GET');
    });

    it('returns the organizations and the reported total', async () => {
      fetchSpy = mockFetch({
        organizations: [{ key: 'acme', name: 'acme' }],
        paging: { pageIndex: 1, pageSize: 100, total: 4 },
      });
      expect(await api.listGithubOrganizations('s', 1, 100)).toEqual({
        organizations: [{ key: 'acme', name: 'acme' }],
        total: 4,
      });
    });

    it('treats an empty result as no organizations and no total', async () => {
      fetchSpy = mockFetch({});
      expect(await api.listGithubOrganizations('s', 1, 100)).toEqual({
        organizations: [],
        total: undefined,
      });
    });

    it('rejects on a 400 such as a missing token', async () => {
      fetchSpy = mockFetchSeq(badRequest('No personal access token found'));
      const error = await api.listGithubOrganizations('s', 1, 100).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestError);
    });
  });

  describe('listGithubRepositories', () => {
    it('sends the setting key, the organization and paging', async () => {
      fetchSpy = mockFetch({ repositories: [], paging: { total: 0 } });
      await api.listGithubRepositories('my-github', 'acme', 3, 100);
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/alm_integrations/list_github_repositories');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        almSetting: 'my-github',
        organization: 'acme',
        p: '3',
        ps: '100',
      });
      expect(lastFetchInit(fetchSpy).method).toBe('GET');
    });

    it('returns the repositories and the reported total', async () => {
      const repositories = [
        {
          id: 1,
          key: 'acme/a',
          name: 'a',
          url: 'https://github.com/acme/a',
          sqProjectKey: 'acme_a',
        },
      ];
      fetchSpy = mockFetch({ repositories, paging: { pageIndex: 1, pageSize: 100, total: 9 } });
      expect(await api.listGithubRepositories('s', 'acme', 1, 100)).toEqual({
        repositories,
        total: 9,
      });
    });

    it('treats an empty result as no repositories and no total', async () => {
      fetchSpy = mockFetch({});
      expect(await api.listGithubRepositories('s', 'acme', 1, 100)).toEqual({
        repositories: [],
        total: undefined,
      });
    });

    it('rejects on a server error', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 500 }));
      const error = await api.listGithubRepositories('s', 'acme', 1, 100).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
    });
  });

  describe('putBoundProject', () => {
    const request = {
      projectKey: 'group_repo',
      projectName: 'repo',
      devOpsPlatformSettingId: 'gl-id',
      repositoryIdentifier: '42',
    };

    it('PUTs the project as JSON with monorepo off', async () => {
      fetchSpy = mockFetch({ projectId: 'p', bindingId: 'b', newProjectCreated: true });
      await api.putBoundProject(request);
      expect(new URL(lastFetchUrl(fetchSpy)).pathname).toBe(
        '/api/v2/dop-translation/bound-projects',
      );
      const init = lastFetchInit(fetchSpy);
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body as string)).toEqual({ ...request, monorepo: false });
    });

    it('passes projectIdentifier through when given', async () => {
      fetchSpy = mockFetch({ newProjectCreated: true });
      await api.putBoundProject({ ...request, projectIdentifier: 'proj' });
      expect(JSON.parse(lastFetchInit(fetchSpy).body as string)).toMatchObject({
        projectIdentifier: 'proj',
      });
    });

    it('reports whether the project was new', async () => {
      fetchSpy = mockFetch({ newProjectCreated: false });
      expect(await api.putBoundProject(request)).toEqual({ newProjectCreated: false });
    });

    it('rejects with the server message on a 400', async () => {
      fetchSpy = mockFetchSeq(badRequest("personal access token for 's' is missing"));
      const error = await api.putBoundProject(request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestError);
      expect((error as BadRequestError).message).toContain('is missing');
    });

    it('rejects on a 500 from the platform', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 500 }));
      const error = await api.putBoundProject(request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
    });

    describe('on a server without PUT', () => {
      const BOUND_PROJECTS = '/api/v2/dop-translation/bound-projects';

      /** Answers each call by method and path; `/api/system/status` reports `version`. */
      function mockServer(answers: {
        put: Response;
        post?: Response;
        version?: string | null;
      }): ReturnType<typeof spyOn> {
        return spyOn(globalThis, 'fetch').mockImplementation(((
          url: string | URL,
          init?: RequestInit,
        ) => {
          const { pathname } = new URL(url.toString());
          if (pathname === '/api/system/status') {
            const { version } = answers;
            return Promise.resolve(
              version === undefined || version === null
                ? fakeResponse({}, { status: 500 })
                : fakeResponse({ status: 'UP', version }),
            );
          }
          const answer = init?.method === 'PUT' ? answers.put : answers.post;
          return Promise.resolve(answer ?? fakeResponse({}, { status: 500 }));
        }) as typeof fetch);
      }

      type FetchCall = [string | URL, RequestInit | undefined];

      function fetchCalls(spy: ReturnType<typeof spyOn>): FetchCall[] {
        return spy.mock.calls as FetchCall[];
      }

      function callsTo(spy: ReturnType<typeof spyOn>, method: string): number {
        return fetchCalls(spy).filter(
          ([url, init]) =>
            new URL(url.toString()).pathname === BOUND_PROJECTS && init?.method === method,
        ).length;
      }

      function versionCalls(spy: ReturnType<typeof spyOn>): number {
        return fetchCalls(spy).filter(
          ([url]) => new URL(url.toString()).pathname === '/api/system/status',
        ).length;
      }

      const created = () =>
        fakeResponse({ projectId: 'p', bindingId: 'b', newProjectCreated: true }, { status: 201 });

      it('POSTs the same body when PUT answers 405, without asking for the version', async () => {
        fetchSpy = mockServer({ put: fakeResponse({}, { status: 405 }), post: created() });
        expect(await api.putBoundProject(request)).toEqual({ newProjectCreated: true });
        expect(callsTo(fetchSpy, 'POST')).toBe(1);
        expect(versionCalls(fetchSpy)).toBe(0);
        const post = fetchCalls(fetchSpy).find(([, init]) => init?.method === 'POST');
        expect(JSON.parse(post?.[1]?.body as string)).toEqual({
          ...request,
          monorepo: false,
        });
      });

      it('POSTs when PUT answers 404 on a server older than 2025.6', async () => {
        fetchSpy = mockServer({
          put: fakeResponse({}, { status: 404 }),
          post: created(),
          version: '10.8',
        });
        expect(await api.putBoundProject(request)).toEqual({ newProjectCreated: true });
        expect(callsTo(fetchSpy, 'POST')).toBe(1);
      });

      it('keeps the original error on a 404 from a server that supports PUT', async () => {
        fetchSpy = mockServer({
          put: fakeResponse({}, { status: 404 }),
          post: created(),
          version: '2025.6.0.12345',
        });
        const error = await api.putBoundProject(request).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UnexpectedApiError);
        expect((error as UnexpectedApiError).status).toBe(404);
        expect(callsTo(fetchSpy, 'POST')).toBe(0);
      });

      it('keeps the original error on a 404 when the version cannot be read', async () => {
        fetchSpy = mockServer({
          put: fakeResponse({}, { status: 404 }),
          post: created(),
          version: null,
        });
        const error = await api.putBoundProject(request).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UnexpectedApiError);
        expect(callsTo(fetchSpy, 'POST')).toBe(0);
      });

      it('decides once: later repositories go straight to POST and the version is read once', async () => {
        fetchSpy = mockServer({
          put: fakeResponse({}, { status: 404 }),
          post: created(),
          version: '10.8',
        });
        await api.putBoundProject(request);
        await api.putBoundProject({ ...request, projectKey: 'other' });
        await api.putBoundProject({ ...request, projectKey: 'third' });
        expect(callsTo(fetchSpy, 'PUT')).toBe(1);
        expect(callsTo(fetchSpy, 'POST')).toBe(3);
        expect(versionCalls(fetchSpy)).toBe(1);
      });

      it('reads the version once for concurrent repositories on a server with PUT', async () => {
        fetchSpy = mockServer({
          put: fakeResponse({}, { status: 404 }),
          version: '2026.1',
        });
        await Promise.all(
          ['a', 'b', 'c'].map((projectKey) =>
            api.putBoundProject({ ...request, projectKey }).catch(() => undefined),
          ),
        );
        expect(versionCalls(fetchSpy)).toBe(1);
        expect(callsTo(fetchSpy, 'POST')).toBe(0);
      });

      it('passes a 400 from POST through: an existing project is never rebound', async () => {
        fetchSpy = mockServer({
          put: fakeResponse({}, { status: 405 }),
          post: badRequest("Project 'group_repo' already exists"),
        });
        const error = await api.putBoundProject(request).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(BadRequestError);
        expect((error as BadRequestError).message).toContain('already exists');
      });

      it('reports an unsupported server, with its version, when POST answers 404', async () => {
        fetchSpy = mockServer({
          put: fakeResponse({}, { status: 404 }),
          post: fakeResponse({}, { status: 404 }),
          version: '10.4',
        });
        const error = await api.putBoundProject(request).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CommandFailedError);
        expect((error as CommandFailedError).message).toBe(
          'SonarQube Server 10.4 does not support importing repositories; 10.5 or later is required.',
        );
        expect((error as CommandFailedError).remediationHint).toContain('Upgrade');
      });

      it('reports an unsupported server without a version when it cannot be read', async () => {
        fetchSpy = mockServer({
          put: fakeResponse({}, { status: 405 }),
          post: fakeResponse({}, { status: 404 }),
          version: null,
        });
        const error = await api.putBoundProject(request).catch((e: unknown) => e);
        expect((error as CommandFailedError).message).toBe(
          'This SonarQube Server does not support importing repositories; 10.5 or later is required.',
        );
      });

      it('keeps a POST 404 on a 10.5+ server as the original error', async () => {
        fetchSpy = mockServer({
          put: fakeResponse({}, { status: 405 }),
          post: fakeResponse({}, { status: 404 }),
          version: '10.8',
        });
        const error = await api.putBoundProject(request).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UnexpectedApiError);
      });
    });
  });

  describe('lookupProject', () => {
    it('asks components/show for the key, percent-encoded', async () => {
      fetchSpy = mockFetch({ component: { key: 'group_repo:x' } });
      expect(await api.lookupProject('group_repo:x')).toBe('found');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/components/show');
      expect(lastFetchUrl(fetchSpy)).toContain('component=group_repo%3Ax');
    });

    it('is missing on a 404', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 404 }));
      expect(await api.lookupProject('k')).toBe('missing');
    });

    it('is hidden on a 403', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 403 }));
      expect(await api.lookupProject('k')).toBe('hidden');
    });

    it('rejects on a 500', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 500 }));
      const error = await api.lookupProject('k').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ServerError);
    });
  });

  describe('searchProjectBindings', () => {
    it('filters the v2 project-bindings by setting and repository', async () => {
      fetchSpy = mockFetch({
        projectBindings: [{ projectKey: 'k', devOpsPlatformSettingId: 'gl-id', repository: '42' }],
      });
      expect(await api.searchProjectBindings('gl-id', 'my repo')).toEqual([
        { projectKey: 'k', devOpsPlatformSettingId: 'gl-id', repository: '42' },
      ]);
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/v2/dop-translation/project-bindings');
      expect(lastFetchUrl(fetchSpy)).toContain('repository=my%20repo');
      expect(url.searchParams.get('dopSettingId')).toBe('gl-id');
    });

    it('returns no bindings when the response has none', async () => {
      fetchSpy = mockFetch({});
      expect(await api.searchProjectBindings('gl-id', '42')).toEqual([]);
    });
  });

  it('probeGithubPat is missing on "No personal access token found"', async () => {
    fetchSpy = mockFetchSeq(badRequest('No personal access token found'));
    expect(await api.probeGithubPat('gh')).toEqual({ status: 'missing' });
  });

  describe('probeGithubPat organizationCount', () => {
    it('counts the organizations of a valid token', async () => {
      fetchSpy = mockFetch({
        organizations: [{ key: 'a' }, { key: 'b' }],
        paging: { total: 2 },
      });
      expect(await api.probeGithubPat('gh')).toEqual({ status: 'valid', organizationCount: 2 });
    });

    it('is 0 for the empty listing GitHub answers to a dead token', async () => {
      fetchSpy = mockFetch({
        organizations: [],
        paging: { pageIndex: 1, pageSize: 100, total: 0 },
      });
      expect(await api.probeGithubPat('gh')).toEqual({ status: 'valid', organizationCount: 0 });
    });

    it('trusts a positive total over an empty page', async () => {
      fetchSpy = mockFetch({ organizations: [], paging: { total: 3 } });
      expect(await api.probeGithubPat('gh')).toEqual({ status: 'valid', organizationCount: 3 });
    });

    it('is unknown when the response has no listing', async () => {
      fetchSpy = mockFetch({});
      expect(await api.probeGithubPat('gh')).toEqual({
        status: 'valid',
        organizationCount: undefined,
      });
      fetchSpy = mockFetchSeq(noContentResponse());
      expect(await api.probeGithubPat('gh')).toEqual({ status: 'valid' });
    });
  });
});
