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

import {
  HTTP_STATUS_BAD_GATEWAY,
  HTTP_STATUS_GATEWAY_TIMEOUT,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from '@/core/http-constants.ts';
import { buildRequest, fetchAuthenticated } from '@/core/server/fetch.ts';

export interface GitLabRepo {
  id: number;
  name: string;
  path_with_namespace: string;
  default_branch: string | null;
  marked_for_deletion_at: string | null | undefined;
}

export interface GitLabTreeEntry {
  name: string;
  type: 'blob' | 'tree';
  path: string;
}

export interface GitLabMergeRequest {
  iid: number;
  web_url: string;
  state: 'opened' | 'closed' | 'merged';
}

const GET_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;
const GITLAB_PAGE_SIZE = 100;
const RETRY_5XX_DELAY_MS = 2_000;
const MAX_RETRIES = 5;
const DEFAULT_RETRY_AFTER_S = 5;

// Only used for idempotent GET requests — writes are issued once without retry.
async function callWithRetry(fn: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fn();
    const retryable =
      response.status === HTTP_STATUS_TOO_MANY_REQUESTS ||
      response.status === HTTP_STATUS_BAD_GATEWAY ||
      response.status === HTTP_STATUS_SERVICE_UNAVAILABLE ||
      response.status === HTTP_STATUS_GATEWAY_TIMEOUT;
    if (!retryable || attempt >= MAX_RETRIES) return response;
    const parsed = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
    const retryAfterS = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETRY_AFTER_S;
    const delayMs =
      response.status === HTTP_STATUS_TOO_MANY_REQUESTS
        ? (retryAfterS + 1) * 1000
        : RETRY_5XX_DELAY_MS;
    await new Promise<void>((r) => setTimeout(r, delayMs));
  }
}

export class GitLabApiError extends Error {
  constructor(
    public readonly status: number,
    context: string,
    public readonly body: string,
  ) {
    super(`GitLab API error ${status} (${context}): ${body}`);
  }
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new GitLabApiError(response.status, context, body);
  }
}

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/api\/v4\/?$/, '').replace(/\/$/, '');
    this.token = token;
  }

  private headers(): Record<string, string> {
    return {
      'PRIVATE-TOKEN': this.token,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v4${path}`;
  }

  private fetchGet(url: string): Promise<Response> {
    return callWithRetry(() =>
      fetchAuthenticated(url, buildRequest('GET', this.headers(), GET_TIMEOUT_MS, undefined)),
    );
  }

  private fetchWrite(url: string, method: string, body?: string): Promise<Response> {
    return fetchAuthenticated(url, buildRequest(method, this.headers(), WRITE_TIMEOUT_MS, body));
  }

  private async fetchAllPages<T>(
    buildUrl: (page: number) => string,
    context: string,
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (;;) {
      const response = await this.fetchGet(buildUrl(page));
      await assertOk(response, `${context} page ${page}`);
      const batch = (await response.json()) as T[];
      items.push(...batch);
      if (batch.length < GITLAB_PAGE_SIZE) break;
      page++;
    }
    return items;
  }

  async getProjectCiConfigPath(projectId: number): Promise<string | null> {
    const url = this.url(`/projects/${projectId}`);
    const response = await this.fetchGet(url);
    await assertOk(response, `getProjectCiConfigPath projectId=${projectId}`);
    const data = (await response.json()) as { ci_config_path?: string | null };
    const path = data.ci_config_path;
    return path != null && path !== '' ? path : null;
  }

  async listGroupRepos(groupPath: string): Promise<GitLabRepo[]> {
    return this.fetchAllPages(
      (page) =>
        this.url(
          `/groups/${encodeURIComponent(groupPath)}/projects?include_subgroups=true&archived=false&per_page=${GITLAB_PAGE_SIZE}&page=${page}`,
        ),
      'listGroupRepos',
    );
  }

  async listRepoTree(projectId: number, ref: string): Promise<GitLabTreeEntry[]> {
    return this.fetchAllPages(
      (page) =>
        this.url(
          `/projects/${projectId}/repository/tree?ref=${encodeURIComponent(ref)}&per_page=${GITLAB_PAGE_SIZE}&page=${page}`,
        ),
      `listRepoTree projectId=${projectId}`,
    );
  }

  async getFileContent(projectId: number, filePath: string, ref: string): Promise<string | null> {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('%2F');
    const url = this.url(
      `/projects/${projectId}/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    );
    const response = await this.fetchGet(url);
    if (response.status === HTTP_STATUS_NOT_FOUND) return null;
    await assertOk(response, `getFileContent projectId=${projectId} path=${filePath}`);
    const data = (await response.json()) as { content: string; encoding: string };
    return Buffer.from(data.content, 'base64').toString('utf8');
  }

  async createBranch(projectId: number, branchName: string): Promise<void> {
    const url = this.url(`/projects/${projectId}/repository/branches`);
    const response = await this.fetchWrite(
      url,
      'POST',
      JSON.stringify({ branch: branchName, ref: 'HEAD' }),
    );
    await assertOk(response, `createBranch projectId=${projectId} branch=${branchName}`);
  }

  async createFile(
    projectId: number,
    filePath: string,
    branch: string,
    content: string,
    commitMessage: string,
  ): Promise<void> {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('%2F');
    const url = this.url(`/projects/${projectId}/repository/files/${encodedPath}`);
    const response = await this.fetchWrite(
      url,
      'POST',
      JSON.stringify({ branch, content, commit_message: commitMessage, encoding: 'text' }),
    );
    await assertOk(response, `createFile projectId=${projectId} path=${filePath}`);
  }

  async updateFile(
    projectId: number,
    filePath: string,
    branch: string,
    content: string,
    commitMessage: string,
  ): Promise<void> {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('%2F');
    const url = this.url(`/projects/${projectId}/repository/files/${encodedPath}`);
    const response = await this.fetchWrite(
      url,
      'PUT',
      JSON.stringify({ branch, content, commit_message: commitMessage, encoding: 'text' }),
    );
    await assertOk(response, `updateFile projectId=${projectId} path=${filePath}`);
  }

  async createMergeRequest(
    projectId: number,
    sourceBranch: string,
    targetBranch: string,
    title: string,
    description: string,
  ): Promise<string> {
    const url = this.url(`/projects/${projectId}/merge_requests`);
    const response = await this.fetchWrite(
      url,
      'POST',
      JSON.stringify({
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        description,
      }),
    );
    await assertOk(response, `createMergeRequest projectId=${projectId}`);
    const data = (await response.json()) as { web_url: string };
    return data.web_url;
  }

  async listOpenMergeRequests(
    projectId: number,
    sourceBranch: string,
  ): Promise<GitLabMergeRequest[]> {
    const url = this.url(
      `/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&state=opened`,
    );
    const response = await this.fetchGet(url);
    await assertOk(response, `listOpenMergeRequests projectId=${projectId}`);
    return (await response.json()) as GitLabMergeRequest[];
  }

  async deleteBranch(projectId: number, branchName: string): Promise<void> {
    const encodedBranch = encodeURIComponent(branchName);
    const url = this.url(`/projects/${projectId}/repository/branches/${encodedBranch}`);
    const response = await this.fetchWrite(url, 'DELETE');
    await assertOk(response, `deleteBranch projectId=${projectId} branch=${branchName}`);
  }
}
