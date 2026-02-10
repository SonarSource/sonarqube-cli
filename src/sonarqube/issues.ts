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
