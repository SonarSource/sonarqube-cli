// SonarQube Projects API wrapper

import { SonarQubeClient } from './client.js';
import type { ProjectsSearchParams, ProjectsSearchResponse } from '../lib/types.js';

export const MAX_PAGE_SIZE = 500;

export class ProjectsClient {
  private readonly client: SonarQubeClient;

  constructor(client: SonarQubeClient) {
    this.client = client;
  }

  /**
   * Search projects with optional query and pagination
   */
  async searchProjects(params: ProjectsSearchParams): Promise<ProjectsSearchResponse> {
    const queryParams: Record<string, string | number> = {};

    if (params.organization) {
      queryParams.organization = params.organization;
    } else {
      queryParams.qualifiers = 'TRK';
    }

    if (params.q) {
      queryParams.q = params.q;
    }

    if (params.ps) {
      queryParams.ps = params.ps;
    }

    if (params.p) {
      queryParams.p = params.p;
    }

    return await this.client.get<ProjectsSearchResponse>('/api/components/search', queryParams);
  }
}
