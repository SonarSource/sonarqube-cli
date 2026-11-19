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

  it('sends the token and API version when reading a repository', async () => {
    fetchSpy = mockFetch(METADATA);
    expect(await client.getRepository(REPO)).toEqual(METADATA);
    expect(lastFetchUrl(fetchSpy)).toBe(`https://api.github.com/repos/${REPO}`);
    expect(lastFetchInit(fetchSpy)).toMatchObject({
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-GitHub-Api-Version': '2026-03-10' },
    });
  });

  it('collects every page, even when the first page is short', async () => {
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
    expect(nthFetchUrl(fetchSpy, 1)).toContain('page=2');
  });

  it('does not send credentials to a host from the pagination header', async () => {
    fetchSpy = mockFetchSeq(
      fakeResponse([METADATA], {
        headers: { link: '<https://other.example/repos?page=2>; rel="next"' },
      }),
      fakeResponse([]),
    );
    await client.listOrganizationRepos('test-org');
    expect(new URL(nthFetchUrl(fetchSpy, 1)).origin).toBe('https://api.github.com');
  });

  it('fails if a later page cannot be read', async () => {
    fetchSpy = mockFetchSeq(
      fakeResponse([METADATA], {
        headers: { link: '<https://api.github.com/orgs/test-org/repos?page=2>; rel="next"' },
      }),
      fakeResponse({ message: 'Forbidden' }, { status: 403 }),
    );
    const error = await client.listOrganizationRepos('test-org').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubApiError);
  });

  it('encodes file paths and branch names and decodes the file contents', async () => {
    const content = 'name: Analysis\n';
    fetchSpy = mockFetch({ encoding: 'base64', content: Buffer.from(content).toString('base64') });
    expect(await client.getFileContent(REPO, 'ci/my workflow.yml', 'release/next')).toBe(content);
    expect(lastFetchUrl(fetchSpy)).toEndWith('/contents/ci/my%20workflow.yml?ref=release%2Fnext');
  });

  it('rejects a directory listing that may have been truncated', async () => {
    fetchSpy = mockFetch(Array.from({ length: 1000 }, () => ({ name: 'build.yml', type: 'file' })));
    const error = await client
      .listRepoTree(REPO, '.github/workflows', 'main')
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ message: expect.stringContaining('incomplete') });
  });

  it('rejects file content that GitHub could not return', async () => {
    fetchSpy = mockFetch({ encoding: 'none', content: '' });
    const error = await client
      .getFileContent(REPO, 'large.yml', 'main')
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(CommandFailedError);
  });

  it('creates a branch from the supplied commit', async () => {
    fetchSpy = mockFetch({}, { status: 201 });
    await client.createBranch(REPO, 'onboarding', 'default-branch-sha');
    expect(lastFetchInit(fetchSpy).method).toBe('POST');
    expect(JSON.parse(lastFetchInit(fetchSpy).body as string)).toEqual({
      ref: 'refs/heads/onboarding',
      sha: 'default-branch-sha',
    });
  });

  it('opens a PR with the supplied title, description and branches', async () => {
    const url = `https://github.com/${REPO}/pull/1`;
    fetchSpy = mockFetch({ html_url: url }, { status: 201 });
    expect(
      await client.createPullRequest(
        REPO,
        'onboarding',
        'develop',
        'Add analysis',
        'Please review',
      ),
    ).toBe(url);
    expect(JSON.parse(lastFetchInit(fetchSpy).body as string)).toEqual({
      head: 'onboarding',
      base: 'develop',
      title: 'Add analysis',
      body: 'Please review',
    });
  });

  it('preserves permission errors and their diagnostics', async () => {
    fetchSpy = mockFetch(
      { message: 'Operation rejected' },
      {
        status: 403,
        headers: {
          'x-github-request-id': 'request-1',
          'x-accepted-github-permissions': 'contents=write',
        },
      },
    );
    const error = await client
      .createBranch(REPO, 'onboarding', 'abc')
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      status: 403,
      operation: 'createBranch',
      isRateLimited: false,
      requestId: 'request-1',
      acceptedPermissions: 'contents=write',
    });
    expect((error as GitHubApiError).body).toContain('Operation rejected');
  });

  it('redacts the token from error messages', async () => {
    fetchSpy = mockFetch({ message: `Rejected ${TOKEN}` }, { status: 401 });
    const error = await client.getRepository(REPO).catch((error: unknown) => error);
    expect(String(error)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it('does not repeat PR creation after losing the connection', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection closed'));
    const error = await client
      .createPullRequest(REPO, 'onboarding', 'main', 'Title', 'Body')
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ message: expect.stringContaining('createPullRequest') });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['not JSON', '{"html_url": 123}'])(
    'rejects an unusable PR response: %s',
    async (body) => {
      fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 201 }));
      const error = await client
        .createPullRequest(REPO, 'onboarding', 'main', 'Title', 'Body')
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ status: 201, operation: 'createPullRequest' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  describe('retries', () => {
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

    it('retries a temporary server error on a read', async () => {
      fetchSpy = mockFetchSeq(fakeResponse({}, { status: 503 }), fakeResponse(METADATA));
      expect(await client.getRepository(REPO)).toEqual(METADATA);
      expect(timeoutSpy.mock.calls[0][1]).toBe(2000);
    });

    it.each([429, 403])('respects Retry-After on HTTP %s', async (status) => {
      fetchSpy = mockFetchSeq(
        fakeResponse({}, { status, headers: { 'retry-after': '2' } }),
        fakeResponse(METADATA),
      );
      await client.getRepository(REPO);
      expect(timeoutSpy.mock.calls[0][1]).toBe(3000);
    });

    it('waits for the primary rate limit to reset', async () => {
      fetchSpy = mockFetchSeq(
        fakeResponse(
          {},
          {
            status: 403,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 30) },
          },
        ),
        fakeResponse(METADATA),
      );
      await client.getRepository(REPO);
      expect(timeoutSpy.mock.calls[0][1]).toBe(31000);
    });

    it('doubles the delay for repeated secondary rate limits', async () => {
      const limited = () =>
        fakeResponse({ message: 'You have exceeded a secondary rate limit' }, { status: 403 });
      fetchSpy = mockFetchSeq(limited(), limited(), fakeResponse(METADATA));
      await client.getRepository(REPO);
      expect(timeoutSpy.mock.calls[0][1]).toBe(60000);
      expect(timeoutSpy.mock.calls[1][1]).toBe(120000);
    });

    it('ignores an empty Retry-After header', async () => {
      fetchSpy = mockFetchSeq(
        fakeResponse({}, { status: 429, headers: { 'retry-after': '' } }),
        fakeResponse(METADATA),
      );
      await client.getRepository(REPO);
      expect(timeoutSpy.mock.calls[0][1]).toBe(60000);
    });

    it('does not retry a permission error', async () => {
      fetchSpy = mockFetch(
        { message: 'Resource not accessible by personal access token' },
        { status: 403 },
      );
      const error = await client.getRepository(REPO).catch((error: unknown) => error);
      expect(error).toMatchObject({ status: 403, isRateLimited: false });
      expect(timeoutSpy).not.toHaveBeenCalled();
    });

    it('stops after five retries and preserves the retry information', async () => {
      fetchSpy = mockFetch(
        {},
        { status: 429, headers: { 'retry-after': '0', 'x-ratelimit-reset': '2000000000' } },
      );
      const error = await client.getRepository(REPO).catch((error: unknown) => error);
      expect(error).toMatchObject({ status: 429, retryAfter: '0', rateLimitReset: '2000000000' });
      expect(fetchSpy).toHaveBeenCalledTimes(6);
    });

    it('does not retry a failed file write', async () => {
      fetchSpy = mockFetch({}, { status: 503 });
      const error = await client
        .createFile(REPO, 'workflow.yml', 'onboarding', 'content', 'Add workflow')
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ status: 503, operation: 'createFile' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('does not retry PR creation when throttled', async () => {
      fetchSpy = mockFetch({}, { status: 429 });
      const error = await client
        .createPullRequest(REPO, 'onboarding', 'main', 'Title', 'Body')
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ status: 429, isRateLimited: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
