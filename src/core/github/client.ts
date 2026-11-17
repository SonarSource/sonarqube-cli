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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { buildRequest, fetchAuthenticated } from '@/core/server/fetch.ts';
import {
  HTTP_STATUS_BAD_GATEWAY,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_GATEWAY_TIMEOUT,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from '@/core/server/http-constants.ts';

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const PAGE_SIZE = 100;
const MAX_RETRIES = 5;
const GET_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;
const RETRY_5XX_DELAY_MS = 2_000;
const INITIAL_RATE_LIMIT_DELAY_MS = 60_000;

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  archived: boolean;
  disabled: boolean;
}

export interface GitHubTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  sha: string;
}

export interface GitHubBranch {
  ref: string;
  object: { sha: string; type: string };
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string };
}

export class GitHubApiError extends CommandFailedError {
  readonly status: number;
  readonly isRateLimited: boolean;
  readonly retryAfter: string | null;
  readonly rateLimitReset: string | null;
  readonly requestId: string | null;
  readonly acceptedPermissions: string | null;

  constructor(
    response: Response,
    readonly operation: string,
    readonly body: string,
  ) {
    super(`GitHub API error ${response.status} (${operation}): ${body}`);
    this.name = 'GitHubApiError';
    this.status = response.status;
    this.retryAfter = response.headers.get('retry-after');
    this.rateLimitReset = response.headers.get('x-ratelimit-reset');
    this.requestId = response.headers.get('x-github-request-id');
    this.acceptedPermissions = response.headers.get('x-accepted-github-permissions');
    this.isRateLimited =
      this.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
      (this.status === HTTP_STATUS_FORBIDDEN &&
        (response.headers.get('x-ratelimit-remaining') === '0' ||
          this.retryAfter !== null ||
          /rate limit|abuse detection/i.test(body)));
  }
}

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl = GITHUB_API_URL,
  ) {}

  async listOrganizationRepos(organization: string): Promise<GitHubRepo[]> {
    return this.fetchAllPages(
      `/orgs/${encodeURIComponent(organization)}/repos?type=all`,
      'listOrganizationRepos',
    );
  }

  async getRepository(repo: string): Promise<GitHubRepo> {
    const response = await this.request('GET', repoPath(repo), 'getRepository');
    return this.readJson(response, 'getRepository');
  }

  async getBranch(repo: string, branch: string): Promise<GitHubBranch | null> {
    const response = await this.request(
      'GET',
      `${repoPath(repo)}/git/ref/heads/${encodeURIComponent(branch)}`,
      'getBranch',
      { allowNotFound: true },
    );
    return response.status === HTTP_STATUS_NOT_FOUND ? null : this.readJson(response, 'getBranch');
  }

  async listRepoTree(repo: string, path: string, ref: string): Promise<GitHubTreeEntry[]> {
    const response = await this.request('GET', contentPath(repo, path, ref), 'listRepoTree', {
      allowNotFound: true,
    });
    if (response.status === HTTP_STATUS_NOT_FOUND) return [];
    const entries = await this.readJson<GitHubTreeEntry[]>(response, 'listRepoTree');
    if (!Array.isArray(entries) || entries.length >= 1000) {
      throw new CommandFailedError('GitHub directory listing is invalid or may be incomplete.');
    }
    return entries;
  }

  async getFileContent(repo: string, path: string, ref: string): Promise<string | null> {
    const response = await this.request('GET', contentPath(repo, path, ref), 'getFileContent', {
      allowNotFound: true,
    });
    if (response.status === HTTP_STATUS_NOT_FOUND) return null;
    const file = await this.readJson<{ encoding: string; content: string } | null>(
      response,
      'getFileContent',
    );
    if (file?.encoding !== 'base64' || typeof file.content !== 'string') {
      throw new CommandFailedError(
        'GitHub did not return readable base64 file content (getFileContent).',
      );
    }
    return Buffer.from(file.content, 'base64').toString('utf8');
  }

  async listOpenPullRequests(repo: string, sourceBranch: string): Promise<GitHubPullRequest[]> {
    const owner = repo.split('/')[0];
    const head = encodeURIComponent(`${owner}:${sourceBranch}`);
    return this.fetchAllPages(
      `${repoPath(repo)}/pulls?state=open&head=${head}`,
      'listOpenPullRequests',
    );
  }

  async createBranch(repo: string, branch: string, sha: string): Promise<void> {
    await this.request('POST', `${repoPath(repo)}/git/refs`, 'createBranch', {
      body: { ref: `refs/heads/${branch}`, sha },
    });
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    await this.request(
      'DELETE',
      `${repoPath(repo)}/git/refs/heads/${encodeURIComponent(branch)}`,
      'deleteBranch',
    );
  }

  async createFile(
    repo: string,
    path: string,
    branch: string,
    content: string,
    message: string,
  ): Promise<void> {
    await this.request('PUT', `${repoPath(repo)}/contents/${encodePath(path)}`, 'createFile', {
      body: { branch, message, content: Buffer.from(content, 'utf8').toString('base64') },
    });
  }

  async createPullRequest(
    repo: string,
    sourceBranch: string,
    targetBranch: string,
    title: string,
    body: string,
  ): Promise<string> {
    const response = await this.request('POST', `${repoPath(repo)}/pulls`, 'createPullRequest', {
      body: { head: sourceBranch, base: targetBranch, title, body },
    });
    const pr = await this.readJson<{ html_url?: string } | null>(response, 'createPullRequest');
    if (typeof pr?.html_url !== 'string' || pr.html_url.length === 0)
      throw new GitHubApiError(response, 'createPullRequest', 'No PR URL returned.');
    return pr.html_url;
  }

  private async fetchAllPages<T>(path: string, operation: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const response = await this.request(
        'GET',
        `${path}&per_page=${PAGE_SIZE}&page=${page}`,
        operation,
      );
      const batch = await this.readJson<T[]>(response, operation);
      if (!Array.isArray(batch))
        throw new CommandFailedError(`GitHub returned an invalid page (${operation}).`);
      items.push(...batch);
      // Numbered pages keep credentials on our configured API host rather than following Link URLs.
      if (!/;\s*rel="next"/.test(response.headers.get('link') ?? '')) return items;
    }
  }

  private async request(
    method: string,
    path: string,
    operation: string,
    options: { body?: object; allowNotFound?: boolean } = {},
  ): Promise<Response> {
    let fallbackRateLimitDelayMs = INITIAL_RATE_LIMIT_DELAY_MS;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetchAuthenticated(
          `${this.baseUrl}${path}`,
          buildRequest(
            method,
            {
              Authorization: `Bearer ${this.token}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'User-Agent': 'sonarqube-cli',
              'X-GitHub-Api-Version': GITHUB_API_VERSION,
            },
            method === 'GET' ? GET_TIMEOUT_MS : WRITE_TIMEOUT_MS,
            options.body === undefined ? undefined : JSON.stringify(options.body),
          ),
        );
      } catch (cause) {
        throw new CommandFailedError(
          `GitHub request failed before a response was received (${operation}).`,
          { cause },
        );
      }
      if (response.ok || (options.allowNotFound && response.status === HTTP_STATUS_NOT_FOUND))
        return response;
      const errorBody = (await response.text().catch(() => '')).replaceAll(
        this.token,
        '[REDACTED]',
      );
      const error = new GitHubApiError(response, operation, errorBody);
      const retryable =
        error.isRateLimited ||
        [
          HTTP_STATUS_BAD_GATEWAY,
          HTTP_STATUS_SERVICE_UNAVAILABLE,
          HTTP_STATUS_GATEWAY_TIMEOUT,
        ].includes(error.status);
      // Writes are issued once; uncertain write outcomes must be reconciled by the lifecycle.
      if (method !== 'GET' || !retryable || attempt >= MAX_RETRIES) throw error;
      const delayMs = retryDelay(error, response.headers, fallbackRateLimitDelayMs);
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      fallbackRateLimitDelayMs *= 2;
    }
  }

  private async readJson<T>(response: Response, operation: string): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new GitHubApiError(response, operation, 'Invalid JSON response.');
    }
  }
}

function retryDelay(
  error: GitHubApiError,
  headers: Headers,
  fallbackRateLimitDelayMs: number,
): number {
  if (!error.isRateLimited) return RETRY_5XX_DELAY_MS;

  const retryAfterSeconds = nonNegativeSeconds(error.retryAfter);
  if (retryAfterSeconds !== undefined) return (retryAfterSeconds + 1) * 1000;

  const resetTimeSeconds = nonNegativeSeconds(error.rateLimitReset);
  if (headers.get('x-ratelimit-remaining') === '0' && resetTimeSeconds !== undefined) {
    return Math.max(0, resetTimeSeconds * 1000 - Date.now()) + 1000;
  }

  return fallbackRateLimitDelayMs;
}

function nonNegativeSeconds(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function repoPath(repo: string): string {
  return `/repos/${encodePath(repo)}`;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function contentPath(repo: string, path: string, ref: string): string {
  return `${repoPath(repo)}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`;
}
