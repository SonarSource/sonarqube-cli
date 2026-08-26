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

import { GitLabApiError, GitLabClient } from '@/core/gitlab/client.ts';

import {
  fakeResponse,
  lastFetchInit,
  lastFetchUrl,
  mockFetch,
  mockFetchSeq,
  nthFetchUrl,
} from '../../helpers/mock-fetch.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_URL = 'https://gitlab.example.com';
const TOKEN = 'glpat-test-token';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitLabClient', () => {
  let client: GitLabClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new GitLabClient(BASE_URL, TOKEN);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Constructor — base URL normalisation
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('strips trailing /api/v4/ from the base URL', async () => {
      const c = new GitLabClient(`${BASE_URL}/api/v4/`, TOKEN);
      fetchSpy = mockFetch({ ci_config_path: null });
      await c.getProjectCiConfigPath(1);
      expect(lastFetchUrl(fetchSpy)).toBe(`${BASE_URL}/api/v4/projects/1`);
    });

    it('strips trailing slash from the base URL', async () => {
      const c = new GitLabClient(`${BASE_URL}/`, TOKEN);
      fetchSpy = mockFetch({ ci_config_path: null });
      await c.getProjectCiConfigPath(1);
      expect(lastFetchUrl(fetchSpy)).toBe(`${BASE_URL}/api/v4/projects/1`);
    });

    it('sends PRIVATE-TOKEN header on every request', async () => {
      fetchSpy = mockFetch({ ci_config_path: null });
      await client.getProjectCiConfigPath(1);
      const headers = lastFetchInit(fetchSpy).headers as Record<string, string>;
      expect(headers['PRIVATE-TOKEN']).toBe(TOKEN);
    });
  });

  // -------------------------------------------------------------------------
  // getProjectCiConfigPath
  // -------------------------------------------------------------------------

  describe('getProjectCiConfigPath', () => {
    it('returns the ci_config_path string when present', async () => {
      fetchSpy = mockFetch({ ci_config_path: 'ci/custom.yml' });
      const result = await client.getProjectCiConfigPath(42);
      expect(result).toBe('ci/custom.yml');
      expect(lastFetchUrl(fetchSpy)).toContain('/projects/42');
    });

    it('returns null when ci_config_path is null', async () => {
      fetchSpy = mockFetch({ ci_config_path: null });
      expect(await client.getProjectCiConfigPath(1)).toBeNull();
    });

    it('returns null when ci_config_path is empty string', async () => {
      fetchSpy = mockFetch({ ci_config_path: '' });
      expect(await client.getProjectCiConfigPath(1)).toBeNull();
    });

    it('returns null when ci_config_path is absent', async () => {
      fetchSpy = mockFetch({});
      expect(await client.getProjectCiConfigPath(1)).toBeNull();
    });

    it('throws on non-ok response', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 403 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.getProjectCiConfigPath(1)).rejects.toThrow('GitLab API error 403');
    });
  });

  // -------------------------------------------------------------------------
  // listGroupRepos
  // -------------------------------------------------------------------------

  describe('listGroupRepos', () => {
    const repo = {
      id: 1,
      name: 'repo',
      path_with_namespace: 'group/repo',
      default_branch: 'main',
      marked_for_deletion_at: null,
    };

    it('returns repos from a single page', async () => {
      fetchSpy = mockFetch([repo]);
      const result = await client.listGroupRepos('my-group');
      expect(result).toEqual([repo]);
      expect(lastFetchUrl(fetchSpy)).toContain('/groups/my-group/projects');
    });

    it('encodes the group path in the URL', async () => {
      fetchSpy = mockFetch([]);
      await client.listGroupRepos('my-org/sub-group');
      expect(lastFetchUrl(fetchSpy)).toContain('/groups/my-org%2Fsub-group/projects');
    });

    it('paginates and returns all repos across pages', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ ...repo, id: i + 1 }));
      const page2 = [{ ...repo, id: 101 }];
      fetchSpy = mockFetchSeq(fakeResponse(page1), fakeResponse(page2));
      const result = await client.listGroupRepos('group');
      expect(result).toHaveLength(101);
      expect(nthFetchUrl(fetchSpy, 0)).toContain('page=1');
      expect(nthFetchUrl(fetchSpy, 1)).toContain('page=2');
    });

    it('stops pagination when page is smaller than page size', async () => {
      fetchSpy = mockFetch([repo]);
      await client.listGroupRepos('group');
      expect(fetchSpy.mock.calls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // listRepoTree
  // -------------------------------------------------------------------------

  describe('listRepoTree', () => {
    const entry = { name: 'README.md', type: 'blob' as const, path: 'README.md' };

    it('returns tree entries from a single page', async () => {
      fetchSpy = mockFetch([entry]);
      const result = await client.listRepoTree(1, 'main');
      expect(result).toEqual([entry]);
      expect(lastFetchUrl(fetchSpy)).toContain('/projects/1/repository/tree');
      expect(lastFetchUrl(fetchSpy)).toContain('ref=main');
    });

    it('paginates and returns all entries across pages', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ ...entry, name: `file${i}` }));
      const page2 = [entry];
      fetchSpy = mockFetchSeq(fakeResponse(page1), fakeResponse(page2));
      const result = await client.listRepoTree(1, 'main');
      expect(result).toHaveLength(101);
      expect(nthFetchUrl(fetchSpy, 1)).toContain('page=2');
    });

    it('encodes the ref in the URL', async () => {
      fetchSpy = mockFetch([]);
      await client.listRepoTree(1, 'feature/my-branch');
      expect(lastFetchUrl(fetchSpy)).toContain('ref=feature%2Fmy-branch');
    });
  });

  // -------------------------------------------------------------------------
  // getFileContent
  // -------------------------------------------------------------------------

  describe('getFileContent', () => {
    it('decodes base64 file content', async () => {
      const content = Buffer.from('hello world').toString('base64');
      fetchSpy = mockFetch({ content, encoding: 'base64' });
      const result = await client.getFileContent(1, '.gitlab-ci.yml', 'main');
      expect(result).toBe('hello world');
    });

    it('returns null on 404', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 404 });
      expect(await client.getFileContent(1, 'missing.yml', 'main')).toBeNull();
    });

    it('encodes path segments with %2F', async () => {
      const content = Buffer.from('x').toString('base64');
      fetchSpy = mockFetch({ content, encoding: 'base64' });
      await client.getFileContent(1, 'ci/sub/file.yml', 'main');
      expect(lastFetchUrl(fetchSpy)).toContain('ci%2Fsub%2Ffile.yml');
    });

    it('throws on non-404 error', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 500 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.getFileContent(1, 'file.yml', 'main')).rejects.toThrow(
        'GitLab API error 500',
      );
    });
  });

  // -------------------------------------------------------------------------
  // createBranch
  // -------------------------------------------------------------------------

  describe('createBranch', () => {
    it('POSTs to the branches endpoint with branch name and HEAD ref', async () => {
      fetchSpy = mockFetch({});
      await client.createBranch(1, 'feature/my-branch');
      const init = lastFetchInit(fetchSpy);
      expect(init.method).toBe('POST');
      expect(lastFetchUrl(fetchSpy)).toContain('/projects/1/repository/branches');
      const body = JSON.parse(init.body as string);
      expect(body.branch).toBe('feature/my-branch');
      expect(body.ref).toBe('HEAD');
    });

    it('throws GitLabApiError with body exposed when the server returns an error', async () => {
      fetchSpy = mockFetch({ message: 'Branch already exists' }, { ok: false, status: 400 });

      const err = await client.createBranch(1, 'bad').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitLabApiError);
      expect((err as GitLabApiError).status).toBe(400);
      expect((err as GitLabApiError).body).toContain('Branch already exists');
    });
  });

  // -------------------------------------------------------------------------
  // createFile / updateFile
  // -------------------------------------------------------------------------

  describe('createFile', () => {
    it('POSTs with correct body fields', async () => {
      fetchSpy = mockFetch({});
      await client.createFile(1, '.gitlab-ci.yml', 'my-branch', 'content', 'Add CI');
      const body = JSON.parse(lastFetchInit(fetchSpy).body as string);
      expect(body.branch).toBe('my-branch');
      expect(body.content).toBe('content');
      expect(body.commit_message).toBe('Add CI');
      expect(body.encoding).toBe('text');
      expect(lastFetchInit(fetchSpy).method).toBe('POST');
    });
  });

  describe('updateFile', () => {
    it('PUTs with correct body fields', async () => {
      fetchSpy = mockFetch({});
      await client.updateFile(1, '.gitlab-ci.yml', 'my-branch', 'updated', 'Update CI');
      const body = JSON.parse(lastFetchInit(fetchSpy).body as string);
      expect(body.branch).toBe('my-branch');
      expect(body.content).toBe('updated');
      expect(lastFetchInit(fetchSpy).method).toBe('PUT');
    });
  });

  // -------------------------------------------------------------------------
  // createMergeRequest
  // -------------------------------------------------------------------------

  describe('createMergeRequest', () => {
    it('POSTs and returns web_url from response', async () => {
      fetchSpy = mockFetch({ web_url: 'https://gitlab.example.com/mr/1' });
      const url = await client.createMergeRequest(1, 'feature', 'main', 'Title', 'Desc');
      expect(url).toBe('https://gitlab.example.com/mr/1');
      const body = JSON.parse(lastFetchInit(fetchSpy).body as string);
      expect(body.source_branch).toBe('feature');
      expect(body.target_branch).toBe('main');
      expect(body.title).toBe('Title');
    });
  });

  // -------------------------------------------------------------------------
  // listOpenMergeRequests
  // -------------------------------------------------------------------------

  describe('listOpenMergeRequests', () => {
    it('returns open MRs for the source branch', async () => {
      const mr = { iid: 1, web_url: 'https://gitlab.example.com/mr/1', state: 'opened' as const };
      fetchSpy = mockFetch([mr]);
      const result = await client.listOpenMergeRequests(1, 'feature/branch');
      expect(result).toEqual([mr]);
      expect(lastFetchUrl(fetchSpy)).toContain('source_branch=feature%2Fbranch');
      expect(lastFetchUrl(fetchSpy)).toContain('state=opened');
    });
  });

  // -------------------------------------------------------------------------
  // deleteBranch
  // -------------------------------------------------------------------------

  describe('deleteBranch', () => {
    it('DELETEs the encoded branch URL', async () => {
      fetchSpy = mockFetch({});
      await client.deleteBranch(1, 'feature/my-branch');
      expect(lastFetchInit(fetchSpy).method).toBe('DELETE');
      expect(lastFetchUrl(fetchSpy)).toContain('feature%2Fmy-branch');
    });
  });

  // -------------------------------------------------------------------------
  // callWithRetry — GET retries
  // -------------------------------------------------------------------------

  describe('callWithRetry', () => {
    let setTimeoutSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it('retries a 429 and succeeds on the next attempt', async () => {
      fetchSpy = mockFetchSeq(
        fakeResponse({}, { ok: false, status: 429, headers: { 'Retry-After': '1' } }),
        fakeResponse({ ci_config_path: null }),
      );
      const result = await client.getProjectCiConfigPath(1);
      expect(result).toBeNull();
      expect(fetchSpy.mock.calls).toHaveLength(2);
    });

    it('uses DEFAULT_RETRY_AFTER_S when Retry-After is an HTTP-date (NaN)', async () => {
      fetchSpy = mockFetchSeq(
        fakeResponse(
          {},
          { ok: false, status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT' } },
        ),
        fakeResponse({ ci_config_path: null }),
      );
      await client.getProjectCiConfigPath(1);
      const delayCall = setTimeoutSpy.mock.calls[0];
      // (DEFAULT_RETRY_AFTER_S=5 + 1) * 1000 = 6000
      expect(delayCall[1]).toBe(6000);
    });

    it('stops retrying after MAX_RETRIES (5) attempts and returns the last response', async () => {
      const responses = Array.from({ length: 6 }, () =>
        fakeResponse({}, { ok: false, status: 429, headers: { 'Retry-After': '0' } }),
      );
      fetchSpy = mockFetchSeq(...responses);
      // Should return the 429 without throwing after MAX_RETRIES exceeded
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.getProjectCiConfigPath(1)).rejects.toThrow('GitLab API error 429');
      expect(fetchSpy.mock.calls).toHaveLength(6); // attempt 0-5, then return
    });

    it('retries 5xx errors on GETs', async () => {
      fetchSpy = mockFetchSeq(
        fakeResponse({}, { ok: false, status: 503 }),
        fakeResponse({ ci_config_path: null }),
      );
      const result = await client.getProjectCiConfigPath(1);
      expect(result).toBeNull();
      expect(fetchSpy.mock.calls).toHaveLength(2);
    });

    it('does NOT retry writes on 5xx — throws immediately', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 503 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.createBranch(1, 'branch')).rejects.toThrow('GitLab API error 503');
      expect(fetchSpy.mock.calls).toHaveLength(1);
    });

    it('does NOT retry createMergeRequest on 5xx', async () => {
      fetchSpy = mockFetch({}, { ok: false, status: 502 });
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(client.createMergeRequest(1, 'src', 'main', 'T', 'D')).rejects.toThrow(
        'GitLab API error 502',
      );
      expect(fetchSpy.mock.calls).toHaveLength(1);
    });
  });
});
