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

// SonarQube Components API wrapper — project existence, identity and project-scoped settings.

import { errAsync, okAsync, type ResultAsync } from '../result.ts';
import type { HttpClientError } from './errors.ts';
import type { QueryParams, SonarHttpClient } from './http-client.ts';
import type { SettingsValue } from './settings-value.ts';
import type { ComponentsTreeResponse } from './types.ts';

/** Thrown by `getProjectSettings` when the project key does not resolve to a component. */
export class ProjectNotFoundError extends Error {
  constructor(projectKey: string) {
    super(`Project '${projectKey}' not found`);
    this.name = 'ProjectNotFoundError';
  }
}

export class ComponentsClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Search a project's components by name via `GET /api/components/tree`. `q` matches a
   * component's own name (basename).
   */
  searchComponentsByName(
    projectKey: string,
    q: string,
    qualifiers: string,
    ps: number,
    scope: { branch?: string; pullRequest?: string } = {},
  ): ResultAsync<ComponentsTreeResponse, HttpClientError> {
    const queryParams: QueryParams = { component: projectKey, q, qualifiers, ps };
    if (scope.branch) {
      queryParams.branch = scope.branch;
    }
    if (scope.pullRequest) {
      queryParams.pullRequest = scope.pullRequest;
    }
    return this.client.get<ComponentsTreeResponse>('/api/components/tree', queryParams);
  }

  /**
   * Check if component (project) exists. Only a 404 is treated as "missing" - every
   * other failure (auth, rate limit, outage, network error) propagates as its normal
   * typed error instead of being reported as a missing component.
   */
  componentExists(
    componentKey: string,
    scope: { branch?: string; pullRequest?: string } = {},
  ): ResultAsync<boolean, HttpClientError> {
    const queryParams: QueryParams = { component: componentKey };
    if (scope.branch) {
      queryParams.branch = scope.branch;
    }
    if (scope.pullRequest) {
      queryParams.pullRequest = scope.pullRequest;
    }
    return this.client
      .getOrNotFound('/api/components/show', queryParams)
      .map((component) => component !== null);
  }

  /**
   * Return the legacy alphanumeric ID for a project component key.
   * The external AI agents API expects this ID (not the human-readable key) as `projectId`.
   * Uses /api/navigation/component - same endpoint the web UI uses; `id` is always present there.
   * Only a 404 resolves to `null` - every other failure propagates, matching `componentExists`.
   */
  getComponentId(componentKey: string): ResultAsync<string | null, HttpClientError> {
    return this.client
      .getOrNotFound<{ id: string }>('/api/navigation/component', { component: componentKey })
      .map((value) => value?.id ?? null);
  }

  hasProjectBeenAnalyzed(projectKey: string): ResultAsync<boolean, HttpClientError> {
    return this.client
      .getOrNotFound<{ analyses?: unknown[] }>('/api/project_analyses/search', {
        project: projectKey,
        ps: 1,
      })
      .map((result) => (result?.analyses?.length ?? 0) > 0);
  }

  /**
   * Fetch project-scoped settings via `/api/settings/values`. The `component`
   * query param scopes the values to a specific project; without it the API
   * returns global defaults. Callers project the raw entries into whatever
   * shape they need (e.g. `parseAnalysisProperties` for SCA).
   */
  getProjectSettings(
    projectKey: string,
  ): ResultAsync<SettingsValue[], HttpClientError | ProjectNotFoundError> {
    return this.client
      .getOrNotFound<{ settings?: SettingsValue[] }>('/api/settings/values', {
        component: projectKey,
      })
      .andThen((result) =>
        result === null
          ? errAsync(new ProjectNotFoundError(projectKey))
          : okAsync(result.settings ?? []),
      );
  }
}
