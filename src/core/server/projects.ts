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
import { type SonarHttpClient } from './http-client.ts';
import type { ProjectsSearchParams, ProjectsSearchResponse } from './types.ts';

/**
 * The `ps` (page size) ceiling on nearly every paginated SonarQube list endpoint - not specific
 * to any one resource. Confirmed identical across `components/search_projects`,
 * `measures/component_tree`, `issues/search`, and `metrics/search`'s own param docs ("must be
 * greater than 0 and less or equal than 500"). The unrelated, narrower
 * `DOP_REPOSITORIES_MAX_PAGE_SIZE` is a real exception specific to that one API.
 */
export const MAX_PAGE_SIZE = 500;

export class ProjectsClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
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
