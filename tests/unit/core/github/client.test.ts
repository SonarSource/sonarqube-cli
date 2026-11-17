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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { GitHubApiError, GitHubClient } from '@/core/github/client.ts';

import {
  fakeResponse,
  lastFetchInit,
  lastFetchUrl,
  mockFetch,
  mockFetchSeq,
  nthFetchUrl,
} from '../../helpers/mock-fetch.ts';

const TOKEN = 'github-test-token';
const REPO = 'test-org/sample';
const METADATA = {
  id: 1,
  name: 'sample',
  full_name: REPO,
  default_branch: 'develop',
  archived: false,
  disabled: false,
};

describe('GitHubClient', () => {
  let client: GitHubClient;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    client = new GitHubClient(TOKEN);
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  const optionalReads = {
    getBranch: () => client.getBranch(REPO, 'missing'),
    listRepoTree: () => client.listRepoTree(REPO, '.github/workflows', 'main'),
    getFileContent: () => client.getFileContent(REPO, 'missing.yml', 'main'),
  };
  const writes = {
    createBranch: () => client.createBranch(REPO, 'onboarding', 'abc'),
    deleteBranch: () => client.deleteBranch(REPO, 'onboarding'),
    createFile: () =>
      client.createFile(
        REPO,
        '.github/workflows/sonarqube.yml',
        'onboarding',
        'name: Analysis',
        'Add analysis',
      ),
    createPullRequest: () => client.createPullRequest(REPO, 'onboarding', 'main', 'Title', 'Body'),
  };

  it('reads repository metadata through authenticated transport with pinned API headers', async () => {
    fetchSpy = mockFetch(METADATA);
    expect(await client.getRepository(REPO)).toEqual(METADATA);
    expect(lastFetchUrl(fetchSpy)).toBe(`https://api.github.com/repos/${REPO}`);
    expect(lastFetchInit(fetchSpy)).toMatchObject({
      method: 'GET',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    });
  });

  it('lists all repository pages, including a short page with a next link', async () => {
    fetchSpy = mockFetchSeq(
      fakeResponse([METADATA], {
        headers: { link: '<https://api.github.com/orgs/test-org/repos?page=2>; rel="next"' },
      }),
      fakeResponse([{ ...METADATA, id: 2 }]),
    );
    expect(await client.listOrganizationRepos('test-org')).toEqual([
      METADATA,
      { ...METADATA, id: 2 },
    ]);
    expect(nthFetchUrl(fetchSpy, 0)).toContain('per_page=100&page=1');
    expect(nthFetchUrl(fetchSpy, 1)).toContain('page=2');
  });

  it('returns an empty list when the organization has no visible repositories', async () => {
    fetchSpy = mockFetch([]);
    expect(await client.listOrganizationRepos('test-org')).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('encodes the organization path without injecting query parameters', async () => {
    fetchSpy = mockFetch([]);
    await client.listOrganizationRepos('org?type=private');
    const url = new URL(lastFetchUrl(fetchSpy));
    expect(url.pathname).toBe('/orgs/org%3Ftype%3Dprivate/repos');
    expect(url.searchParams.get('type')).toBe('all');
  });

  it('stops without a next link even if a page contains 100 entries', async () => {
    fetchSpy = mockFetch(Array.from({ length: 100 }, () => METADATA));
    expect(await client.listOrganizationRepos('test-org')).toHaveLength(100);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('builds pagination URLs on the API host rather than forwarding the PAT to Link URLs', async () => {
    fetchSpy = mockFetchSeq(
      fakeResponse([METADATA], {
        headers: { link: '<https://other.example/repos?page=2>; rel="next"' },
      }),
      fakeResponse([]),
    );
    await client.listOrganizationRepos('test-org');
    expect(nthFetchUrl(fetchSpy, 1)).toBe(
      'https://api.github.com/orgs/test-org/repos?type=all&per_page=100&page=2',
    );
  });

  it('propagates a later-page failure instead of returning partial inventory', async () => {
    fetchSpy = mockFetchSeq(
      fakeResponse([METADATA], {
        headers: { link: '<https://api.github.com/orgs/test-org/repos?page=2>; rel="next"' },
      }),
      fakeResponse({ message: 'Forbidden' }, { status: 403 }),
    );
    const error = await client.listOrganizationRepos('test-org').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubApiError);
  });

  it('reads an exact branch ref and its commit SHA', async () => {
    const branch = { ref: 'refs/heads/release/next', object: { sha: 'abc123', type: 'commit' } };
    fetchSpy = mockFetch(branch);
    expect(await client.getBranch(REPO, 'release/next')).toEqual(branch);
    expect(lastFetchUrl(fetchSpy)).toEndWith('/git/ref/heads/release%2Fnext');
  });

  it('reads workflow directory entries at the requested ref', async () => {
    const entry = {
      name: 'build.yml',
      path: '.github/workflows/build.yml',
      type: 'file' as const,
      sha: 'abc',
    };
    fetchSpy = mockFetch([entry]);
    expect(await client.listRepoTree(REPO, '.github/workflows', 'release/next')).toEqual([entry]);
    expect(lastFetchUrl(fetchSpy)).toEndWith('/contents/.github/workflows?ref=release%2Fnext');
  });

  it('decodes workflow file content including base64 line breaks and Unicode', async () => {
    const content = 'name: Analysis\n# ünicode\n';
    fetchSpy = mockFetch({
      encoding: 'base64',
      content: Buffer.from(content).toString('base64') + '\n',
    });
    expect(await client.getFileContent(REPO, 'ci/my workflow.yml', 'main')).toBe(content);
    expect(lastFetchUrl(fetchSpy)).toContain('/contents/ci/my%20workflow.yml?ref=main');
  });

  it('returns absence for missing branches, directories and files, but errors for missing repositories', async () => {
    fetchSpy = mockFetch({}, { status: 404 });
    expect(await client.getBranch(REPO, 'missing')).toBeNull();
    expect(await client.listRepoTree(REPO, '.github/workflows', 'main')).toEqual([]);
    expect(await client.getFileContent(REPO, 'missing.yml', 'main')).toBeNull();
    expect(await client.getRepository(REPO).catch((error: unknown) => error)).toBeInstanceOf(
      GitHubApiError,
    );
  });

  it.each(['getBranch', 'listRepoTree', 'getFileContent'] as const)(
    'propagates non-404 errors from %s',
    async (operation) => {
      fetchSpy = mockFetch({ message: 'Forbidden' }, { status: 403 });
      const error = await optionalReads[operation]().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error).toMatchObject({ status: 403, operation, isRateLimited: false });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a potentially truncated directory listing', async () => {
    const entry = {
      name: 'build.yml',
      path: '.github/workflows/build.yml',
      type: 'file',
      sha: 'abc',
    };
    fetchSpy = mockFetch(Array.from({ length: 1000 }, () => entry));
    expect(
      await client.listRepoTree(REPO, '.github/workflows', 'main').catch((error: unknown) => error),
    ).toBeInstanceOf(CommandFailedError);
  });

  it('rejects unreadable file content instead of treating it as empty', async () => {
    fetchSpy = mockFetch({ encoding: 'none', content: '' });
    expect(
      await client.getFileContent(REPO, 'large.yml', 'main').catch((error: unknown) => error),
    ).toBeInstanceOf(CommandFailedError);
  });

  it('reads an existing empty file as empty content', async () => {
    fetchSpy = mockFetch({ encoding: 'base64', content: '' });
    expect(await client.getFileContent(REPO, 'empty.yml', 'main')).toBe('');
  });

  it('rejects a file response with missing content', async () => {
    fetchSpy = mockFetch({ encoding: 'base64' });
    const error = await client
      .getFileContent(REPO, 'bad.yml', 'main')
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toContain('getFileContent');
  });

  it('paginates open PRs using the owner-qualified source branch', async () => {
    const pr = {
      number: 1,
      html_url: 'https://github.com/test-org/sample/pull/1',
      state: 'open' as const,
      head: { ref: 'sonar/add-sonar-analysis-job', sha: 'abc' },
      base: { ref: 'develop' },
    };
    fetchSpy = mockFetchSeq(
      fakeResponse([pr], {
        headers: {
          link: '<https://api.github.com/repos/test-org/sample/pulls?page=2>; rel="next"',
        },
      }),
      fakeResponse([]),
    );
    expect(await client.listOpenPullRequests(REPO, 'sonar/add-sonar-analysis-job')).toEqual([pr]);
    const query = new URL(nthFetchUrl(fetchSpy, 0)).searchParams;
    expect(query.get('head')).toBe('test-org:sonar/add-sonar-analysis-job');
    expect(query.get('state')).toBe('open');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('creates a branch from the explicitly supplied SHA', async () => {
    fetchSpy = mockFetch({}, { status: 201 });
    await client.createBranch(REPO, 'sonar/add-sonar-analysis-job', 'default-branch-sha');
    expect(lastFetchUrl(fetchSpy)).toEndWith('/git/refs');
    expect(lastFetchInit(fetchSpy)).toMatchObject({
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(lastFetchInit(fetchSpy).body as string)).toEqual({
      ref: 'refs/heads/sonar/add-sonar-analysis-job',
      sha: 'default-branch-sha',
    });
  });

  it('deletes the specified branch', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await client.deleteBranch(REPO, 'sonar/add-sonar-analysis-job');
    expect(lastFetchUrl(fetchSpy)).toEndWith('/git/refs/heads/sonar%2Fadd-sonar-analysis-job');
    expect(lastFetchInit(fetchSpy).method).toBe('DELETE');
  });

  it('creates a base64 workflow file on the requested branch', async () => {
    fetchSpy = mockFetch({}, { status: 201 });
    await client.createFile(
      REPO,
      '.github/workflows/sonarqube.yml',
      'onboarding',
      'name: Analysis\n',
      'Add analysis',
    );
    expect(lastFetchInit(fetchSpy).method).toBe('PUT');
    expect(lastFetchUrl(fetchSpy)).toEndWith('/contents/.github/workflows/sonarqube.yml');
    expect(JSON.parse(lastFetchInit(fetchSpy).body as string)).toEqual({
      branch: 'onboarding',
      message: 'Add analysis',
      content: Buffer.from('name: Analysis\n').toString('base64'),
    });
  });

  it('does not overwrite an existing file after GitHub rejects file creation', async () => {
    fetchSpy = mockFetch({ message: 'sha was not supplied' }, { status: 422 });
    const error = await writes.createFile().catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 422, operation: 'createFile' });
    expect(JSON.parse(lastFetchInit(fetchSpy).body as string)).not.toHaveProperty('sha');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('creates a PR against the requested target branch and returns its URL', async () => {
    const url = 'https://github.com/test-org/sample/pull/1';
    fetchSpy = mockFetch({ html_url: url }, { status: 201 });
    expect(
      await client.createPullRequest(
        REPO,
        'onboarding',
        'develop',
        'Add analysis',
        'Review this workflow',
      ),
    ).toBe(url);
    expect(JSON.parse(lastFetchInit(fetchSpy).body as string)).toEqual({
      head: 'onboarding',
      base: 'develop',
      title: 'Add analysis',
      body: 'Review this workflow',
    });
    expect(lastFetchInit(fetchSpy).method).toBe('POST');
  });

  it.each([401, 403, 422])(
    'preserves failed write HTTP %s and diagnostics without retrying',
    async (status) => {
      fetchSpy = mockFetch(
        { message: 'Operation rejected' },
        {
          status,
          headers: {
            'x-github-request-id': 'request-1',
            'x-accepted-github-permissions': 'contents=write',
          },
        },
      );
      const error = await client
        .createBranch(REPO, 'onboarding', 'abc')
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error).toMatchObject({
        status,
        operation: 'createBranch',
        isRateLimited: false,
        requestId: 'request-1',
        acceptedPermissions: 'contents=write',
      });
      expect((error as GitHubApiError).body).toContain('Operation rejected');
      expect((error as Error).message).toContain('createBranch');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('redacts the PAT if an error response echoes it', async () => {
    fetchSpy = mockFetch({ message: `Rejected ${TOKEN}` }, { status: 401 });
    const error = await client.getRepository(REPO).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(String(error)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it.each(['createBranch', 'deleteBranch', 'createFile', 'createPullRequest'] as const)(
    'does not retry %s after a connection loss and exposes the failed operation',
    async (operation) => {
      const cause = new Error('Connection closed');
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(cause);
      const error = await writes[operation]().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CommandFailedError);
      expect(error).toMatchObject({ cause, message: expect.stringContaining(operation) });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['not JSON', '{}', 'null', '{"html_url": 123}'])(
    'does not retry a PR write after an unusable success response: %s',
    async (body) => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 201 }));
      const error = await client
        .createPullRequest(REPO, 'onboarding', 'main', 'Title', 'Body')
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CommandFailedError);
      expect(error).toMatchObject({ status: 201, operation: 'createPullRequest' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  describe('GET retries', () => {
    let timeoutSpy: ReturnType<typeof spyOn>;
    let nowSpy: ReturnType<typeof spyOn>;
    const now = 1_700_000_000_000;

    beforeEach(() => {
      nowSpy = spyOn(Date, 'now').mockReturnValue(now);
      timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
    });

    afterEach(() => {
      timeoutSpy.mockRestore();
      nowSpy.mockRestore();
    });

    it.each([429, 403])('respects Retry-After on HTTP %s', async (status) => {
      fetchSpy = mockFetchSeq(
        fakeResponse({ message: 'Rate limited' }, { status, headers: { 'retry-after': '2' } }),
        fakeResponse(METADATA),
      );
      expect(await client.getRepository(REPO)).toEqual(METADATA);
      expect(timeoutSpy.mock.calls[0][1]).toBe(3000);
    });

    it('waits until the primary rate-limit reset time', async () => {
      const reset = now / 1000 + 30;
      fetchSpy = mockFetchSeq(
        fakeResponse(
          {},
          {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
          },
        ),
        fakeResponse(METADATA),
      );
      await client.getRepository(REPO);
      const delay = timeoutSpy.mock.calls[0][1] as number;
      expect(delay).toBe(31000);
    });

    it('backs off on secondary rate limits without retry headers', async () => {
      const response = () =>
        fakeResponse({ message: 'You have exceeded a secondary rate limit' }, { status: 403 });
      fetchSpy = mockFetchSeq(response(), response(), fakeResponse(METADATA));
      await client.getRepository(REPO);
      expect(timeoutSpy.mock.calls[0][1]).toBe(60000);
      expect(timeoutSpy.mock.calls[1][1]).toBe(120000);
    });

    it.each(['', 'not-a-number', '-1', 'Wed, 21 Oct 2015 07:28:00 GMT'])(
      'falls back to the rate-limit delay for unusable Retry-After %s',
      async (retryAfter) => {
        fetchSpy = mockFetchSeq(
          fakeResponse({}, { status: 429, headers: { 'retry-after': retryAfter } }),
          fakeResponse(METADATA),
        );
        await client.getRepository(REPO);
        expect(timeoutSpy.mock.calls[0][1]).toBe(60000);
      },
    );

    it('falls back to the rate-limit delay for an unusable primary reset time', async () => {
      fetchSpy = mockFetchSeq(
        fakeResponse(
          {},
          {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'invalid' },
          },
        ),
        fakeResponse(METADATA),
      );
      await client.getRepository(REPO);
      expect(timeoutSpy.mock.calls[0][1]).toBe(60000);
    });

    it('does not retry authorization failures', async () => {
      fetchSpy = mockFetch(
        { message: 'Resource not accessible by personal access token' },
        { status: 403 },
      );
      const error = await client.getRepository(REPO).catch((error: unknown) => error);
      expect(error).toMatchObject({ status: 403, isRateLimited: false });
      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('preserves retry information when the bounded retries are exhausted', async () => {
      fetchSpy = mockFetch(
        { message: 'Rate limited' },
        { status: 429, headers: { 'retry-after': '0', 'x-ratelimit-reset': '2000000000' } },
      );
      const error = await client.getRepository(REPO).catch((error: unknown) => error);
      expect(error).toMatchObject({
        status: 429,
        isRateLimited: true,
        retryAfter: '0',
        rateLimitReset: '2000000000',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(6);
      expect(timeoutSpy).toHaveBeenCalledTimes(5);
    });

    it.each([502, 503, 504])('retries transient HTTP %s on reads', async (status) => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status }), fakeResponse(METADATA));
      expect(await client.getRepository(REPO)).toEqual(METADATA);
      expect(timeoutSpy.mock.calls[0][1]).toBe(2000);
    });

    describe.each([503, 429])('HTTP %s writes', (status) => {
      it.each(['createBranch', 'deleteBranch', 'createFile', 'createPullRequest'] as const)(
        'does not retry %s',
        async (operation) => {
          fetchSpy = mockFetch({}, { status, headers: { 'retry-after': '1' } });
          const error = await writes[operation]().catch((error: unknown) => error);
          expect(error).toBeInstanceOf(GitHubApiError);
          expect(error).toMatchObject({ status, operation, isRateLimited: status === 429 });
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          expect(timeoutSpy).not.toHaveBeenCalled();
        },
      );
    });
  });
});
