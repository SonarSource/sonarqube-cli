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

// GitHub API client — organization listing

import { version as VERSION } from '../../package.json';

const GITHUB_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15000;

export interface GitHubOrganization {
  login: string;
  description: string | null;
}

export class GitHubClient {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  private commonHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `sonarqube-cli/${VERSION}`,
    };
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${GITHUB_API_BASE}${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.commonHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const detail = body ? ` - ${body}` : '';
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}${detail}`);
    }

    return (await response.json()) as T;
  }

  /**
   * List all organizations the authenticated user belongs to.
   * Paginates automatically up to 1000 orgs.
   */
  async listOrganizations(): Promise<GitHubOrganization[]> {
    const orgs: GitHubOrganization[] = [];
    const perPage = 100;
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const batch = await this.get<GitHubOrganization[]>(
        `/user/orgs?per_page=${perPage}&page=${page}`,
      );
      orgs.push(...batch);
      hasMore = batch.length === perPage;
      page++;
    }

    return orgs;
  }
}
