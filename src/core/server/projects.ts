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
import { errAsync, okAsync, type ResultAsync } from '../result.ts';
import { type HttpClientError, isForbiddenRead } from './errors.ts';
import { type SonarHttpClient } from './http-client.ts';
import type {
  ComponentShowResponse,
  ProjectsSearchParams,
  ProjectsSearchResponse,
  SonarQubeProject,
} from './types.ts';

/**
 * The `ps` (page size) ceiling on nearly every paginated SonarQube list endpoint - not specific
 * to any one resource. Confirmed identical across `components/search_projects`,
 * `measures/component_tree`, `issues/search`, and `metrics/search`'s own param docs ("must be
 * greater than 0 and less or equal than 500"). The unrelated, narrower
 * `DOP_REPOSITORIES_MAX_PAGE_SIZE` is a real exception specific to that one API.
 */
export const MAX_PAGE_SIZE = 500;

/** Ids sent per `search_projects` call, which keeps the URL short and the answer on one page. */
const PROJECT_IDS_PER_REQUEST = 50;

export interface PublicProjectsResponse {
  projects?: ({ id?: unknown; key?: unknown } | null)[];
  page?: { total?: number };
}

export type ProjectVisibility = 'private' | 'public';

/** Same vocabulary as `GitRemoteBinding`; `in-org` also covers a lookup with no organization (Server). */
export type ProjectLookup =
  { kind: 'in-org'; project: SonarQubeProject } | { kind: 'missing' } | { kind: 'other-org' };

export interface CreateProjectParams {
  projectKey: string;
  name: string;
  visibility: ProjectVisibility;
  organization?: string;
}

export class ProjectsClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  getProjectsByKey(
    key: string,
  ): ResultAsync<PublicProjectsResponse | null | undefined, HttpClientError> {
    return this.client.get('/api/v2/components/projects', { keys: key, pageSize: 1 });
  }

  /**
   * Search projects with optional query and pagination
   */
  searchProjects(
    params: ProjectsSearchParams,
  ): ResultAsync<ProjectsSearchResponse, HttpClientError> {
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

    return this.client.get<ProjectsSearchResponse>('/api/components/search', queryParams);
  }

  /**
   * Tells a project that is absent from one that belongs to another organization (Cloud only,
   * where a project the token cannot read answers 403). Only a 404 or a component that is not a
   * project reads as `missing`; every other failure propagates, so an outage never reads as
   * "missing".
   */
  lookupProject(
    projectKey: string,
    organization?: string,
  ): ResultAsync<ProjectLookup, HttpClientError> {
    return this.client
      .getOrNullIf404<ComponentShowResponse>('/api/components/show', { component: projectKey })
      .map((response): ProjectLookup => {
        const component = response?.component;
        if (component?.qualifier !== 'TRK') {
          return { kind: 'missing' };
        }
        const inOrganization =
          !organization || !component.organization || component.organization === organization;
        return inOrganization
          ? {
              kind: 'in-org',
              project: { key: component.key, name: component.name ?? component.key },
            }
          : { kind: 'other-org' };
      })
      .orElse((error) =>
        organization !== undefined && isForbiddenRead(error)
          ? okAsync<ProjectLookup, HttpClientError>({ kind: 'other-org' })
          : errAsync(error),
      );
  }

  /**
   * Resolves the project with this key, or `null` when the server has no such project. Only a
   * 404, a component that is not a project, or (on Cloud) a project of another organization
   * resolves to `null`; every other failure propagates, so an outage never reads as "missing".
   */
  findProject(
    projectKey: string,
    organization?: string,
  ): ResultAsync<SonarQubeProject | null, HttpClientError> {
    return this.lookupProject(projectKey, organization).map((lookup) =>
      lookup.kind === 'in-org' ? lookup.project : null,
    );
  }

  /**
   * The keys of the organization's projects with these ids, via `GET /api/components/search_projects`
   * (SonarQube Cloud only). An id of a project outside the organization yields no key.
   */
  findProjectKeysByIds(
    organization: string,
    projectIds: string[],
  ): ResultAsync<string[], HttpClientError> {
    let keys: ResultAsync<string[], HttpClientError> = okAsync([]);
    for (let start = 0; start < projectIds.length; start += PROJECT_IDS_PER_REQUEST) {
      const batch = projectIds.slice(start, start + PROJECT_IDS_PER_REQUEST);
      // Chained rather than parallel: a few small requests at most.
      keys = keys.andThen((found) =>
        this.client
          .get<{ components?: Array<{ key: string }> }>('/api/components/search_projects', {
            organization,
            projectIds: batch.join(','),
            ps: PROJECT_IDS_PER_REQUEST,
          })
          .map((response) => [...found, ...(response.components ?? []).map(({ key }) => key)]),
      );
    }
    return keys;
  }

  /** Creates an empty project that is not bound to any repository. */
  createProject(params: CreateProjectParams): ResultAsync<SonarQubeProject, HttpClientError> {
    return this.client
      .postFormJson<{ project: { key: string; name: string } }>('/api/projects/create', {
        project: params.projectKey,
        name: params.name,
        visibility: params.visibility,
        ...(params.organization ? { organization: params.organization } : {}),
      })
      .map(({ project }) => ({ key: project.key, name: project.name }));
  }
}
