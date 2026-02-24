/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// SonarQube Issues API wrapper

import { SonarQubeClient } from './client.js';
import type { IssuesSearchParams, IssuesSearchResponse } from '../lib/types.js';

const DEFAULT_PAGE_SIZE_ISSUES = 500;

export class IssuesClient {
  private readonly client: SonarQubeClient;

  constructor(client: SonarQubeClient) {
    this.client = client;
  }

  /**
   * Search issues with filters
   */
  async searchIssues(params: IssuesSearchParams): Promise<IssuesSearchResponse> {
    const queryParams: Record<string, string | number | boolean> = {};

    if (params.componentKeys) queryParams.componentKeys = params.componentKeys;
    if (params.projects) queryParams.projects = params.projects;
    if (params.severities) queryParams.severities = params.severities;
    if (params.types) queryParams.types = params.types;
    if (params.statuses) queryParams.statuses = params.statuses;
    if (params.rules) queryParams.rules = params.rules;
    if (params.tags) queryParams.tags = params.tags;
    if (params.branch) queryParams.branch = params.branch;
    if (params.pullRequest) queryParams.pullRequest = params.pullRequest;
    if (params.resolved !== undefined) queryParams.resolved = params.resolved;
    if (params.s) queryParams.s = params.s;
    if (params.ps) queryParams.ps = params.ps;
    if (params.p) queryParams.p = params.p;

    return await this.client.get<IssuesSearchResponse>('/api/issues/search', queryParams);
  }

  /**
   * Search all issues with pagination
   */
  async searchAllIssues(params: IssuesSearchParams): Promise<IssuesSearchResponse> {
    let page = 1;
    let allIssues: IssuesSearchResponse['issues'] = [];
    let totalPages = 1;
    let lastResponse: IssuesSearchResponse;

    do {
      lastResponse = await this.searchIssues({
        ...params,
        p: page,
        ps: params.ps || DEFAULT_PAGE_SIZE_ISSUES
      });

      allIssues = allIssues.concat(lastResponse.issues);
      totalPages = Math.ceil(lastResponse.paging.total / lastResponse.paging.pageSize);
      page++;
    } while (page <= totalPages);

    // Return last response with all accumulated issues
    return {
      ...lastResponse,
      issues: allIssues,
      total: allIssues.length
    };
  }
}
