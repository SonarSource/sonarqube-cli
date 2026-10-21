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
import { AccessDeniedError, BadRequestError, ServerError } from '@/core/server/errors.ts';
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
    api = new ServerImportApiClient(new SonarHttpClient(SERVER_URL, 'squ_token'));
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

    it('rejects with the original error on a 400 that is not about the token', async () => {
      fetchSpy = mockFetchSeq(badRequest('Unable to contact Bitbucket server'));
      const error = await statusOf('s').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestError);
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

  describe('listAzureProjects', () => {
    it('sends the setting key as almSetting, and nothing else', async () => {
      fetchSpy = mockFetch({ projects: [] });
      await api.listAzureProjects('my-azure');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/alm_integrations/list_azure_projects');
      expect(Object.fromEntries(url.searchParams)).toEqual({ almSetting: 'my-azure' });
    });

    it('returns the projects', async () => {
      fetchSpy = mockFetch({ projects: [{ name: 'p1', description: 'd1' }, { name: 'p2' }] });
      expect(await api.listAzureProjects('s')).toEqual([
        { name: 'p1', description: 'd1' },
        { name: 'p2' },
      ]);
    });

    it('treats a response without projects as an empty list', async () => {
      fetchSpy = mockFetch({});
      expect(await api.listAzureProjects('s')).toEqual([]);
    });

    it('rejects on a 400 such as a missing token', async () => {
      fetchSpy = mockFetchSeq(badRequest('No personal access token found'));
      const error = await api.listAzureProjects('s').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestError);
    });
  });

  describe('searchAzureRepos', () => {
    it('sends the setting key as almSetting and the project as projectName', async () => {
      fetchSpy = mockFetch({ repositories: [] });
      await api.searchAzureRepos('my-azure', 'My Project');
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/alm_integrations/search_azure_repos');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        almSetting: 'my-azure',
        projectName: 'My Project',
      });
    });

    it('returns the repositories with their project and the SonarQube project they are bound to', async () => {
      const repositories = [
        { name: 'r1', projectName: 'p1', sqProjectKey: 'p1_r1', sqProjectName: 'r1' },
        { name: 'r2', projectName: 'p1' },
      ];
      fetchSpy = mockFetch({ repositories });
      expect(await api.searchAzureRepos('s', 'p1')).toEqual(repositories);
    });

    it('treats a response without repositories as an empty list', async () => {
      fetchSpy = mockFetch({});
      expect(await api.searchAzureRepos('s', 'p1')).toEqual([]);
    });

    it('rejects on a 400 such as a missing token', async () => {
      fetchSpy = mockFetchSeq(badRequest('No personal access token found'));
      const error = await api.searchAzureRepos('s', 'p1').catch((e: unknown) => e);
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

  describe('listBitbucketServerProjects', () => {
    it('sends the setting key, start offset and page size', async () => {
      fetchSpy = mockFetch({ projects: [], isLastPage: true });
      await api.listBitbucketServerProjects('my-bbs', 25, 100);
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/alm_integrations/list_bitbucketserver_projects');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        almSetting: 'my-bbs',
        start: '25',
        pageSize: '100',
      });
    });

    it('returns the projects and where the next page starts', async () => {
      fetchSpy = mockFetch({
        projects: [{ key: 'PRJ', name: 'Project' }],
        isLastPage: false,
        nextPageStart: 25,
        paging: { pageSize: 1 },
      });
      expect(await api.listBitbucketServerProjects('s', 0, 25)).toEqual({
        projects: [{ key: 'PRJ', name: 'Project' }],
        nextStart: 25,
      });
    });

    it('has no next page on the last one, whatever nextPageStart says', async () => {
      fetchSpy = mockFetch({ projects: [], isLastPage: true, nextPageStart: 25 });
      expect((await api.listBitbucketServerProjects('s', 0, 25)).nextStart).toBeUndefined();
    });

    it('treats an empty result as no projects', async () => {
      fetchSpy = mockFetch({});
      expect(await api.listBitbucketServerProjects('s', 0, 25)).toEqual({
        projects: [],
        nextStart: undefined,
      });
    });

    it('has no next page when the offset would not advance', async () => {
      fetchSpy = mockFetch({ projects: [], isLastPage: false, nextPageStart: 25 });
      expect((await api.listBitbucketServerProjects('s', 25, 25)).nextStart).toBeUndefined();
    });

    it('rejects on a 400 such as a missing token', async () => {
      fetchSpy = mockFetchSeq(badRequest('No personal access token found'));
      const error = await api.listBitbucketServerProjects('s', 0, 25).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestError);
    });
  });

  describe('searchBitbucketServerRepos', () => {
    it('sends the setting key, project name, start offset and page size', async () => {
      fetchSpy = mockFetch({ repositories: [], isLastPage: true });
      await api.searchBitbucketServerRepos('my-bbs', 'My Project', 50, 100);
      const url = new URL(lastFetchUrl(fetchSpy));
      expect(url.pathname).toBe('/api/alm_integrations/search_bitbucketserver_repos');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        almSetting: 'my-bbs',
        projectName: 'My Project',
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
      expect(await api.searchBitbucketServerRepos('s', 'Project', 0, 100)).toEqual({
        repositories,
        nextStart: 2,
      });
    });

    it('has no next page on the last one', async () => {
      fetchSpy = mockFetch({ repositories: [], isLastPage: true });
      expect((await api.searchBitbucketServerRepos('s', 'P', 0, 100)).nextStart).toBeUndefined();
    });

    it('treats an empty result as no repositories', async () => {
      fetchSpy = mockFetch({});
      expect(await api.searchBitbucketServerRepos('s', 'P', 0, 100)).toEqual({
        repositories: [],
        nextStart: undefined,
      });
    });

    it('rejects on a server error', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 500 }));
      const error = await api.searchBitbucketServerRepos('s', 'P', 0, 100).catch((e: unknown) => e);
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

    it('prefers the reported total when the page holds only part of the organizations', async () => {
      fetchSpy = mockFetch({ organizations: [{ key: 'a' }, { key: 'b' }], paging: { total: 150 } });
      expect(await api.probeGithubPat('gh')).toEqual({ status: 'valid', organizationCount: 150 });
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
