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

// SonarQube project-bindings API wrapper: mapping DevOps platform repositories to projects.

import logger from '../observability/logger.ts';
import { okAsync, type ResultAsync } from '../result.ts';
import type { HttpClientError } from './errors.ts';
import { stripGitRemoteUrlUserinfo } from './git-remote-url.ts';
import type { SonarHttpClient } from './http-client.ts';
import { hasNextPage, type Paging } from './paging.ts';

export class ProjectBindingsClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Resolve a project key from a git repository remote URL using server-side bindings.
   * Null means a successful empty binding lookup; undefined means skipped, failed, or ambiguous.
   * SonarQube Server: GET /api/v2/dop-translation/project-bindings
   * SonarQube Cloud: GET /dop-translation/project-bindings, then search_projects by project id.
   */
  getProjectKeyByGitRemote(
    remoteUrl: string,
    orgKey?: string,
  ): ResultAsync<string | null | undefined, HttpClientError> {
    const sanitizedRemoteUrl = stripGitRemoteUrlUserinfo(remoteUrl);
    if (this.client.isCloud) {
      if (!orgKey) {
        return okAsync(undefined);
      }
      return this.getSqcProjectIdByRemoteUrl(sanitizedRemoteUrl).andThen((projectId) => {
        if (!projectId) {
          return okAsync(projectId);
        }
        return this.getSonarCloudProjectKeyById(projectId, orgKey);
      });
    }
    return this.getSqsProjectBindingByRemoteUrl(sanitizedRemoteUrl).map((binding) =>
      binding === null ? null : binding?.projectKey,
    );
  }

  private getSqsProjectBindingByRemoteUrl(
    remoteUrl: string,
  ): ResultAsync<{ projectKey: string } | null | undefined, HttpClientError> {
    const endpoint = `/api/v2/dop-translation/project-bindings?repositoryUrl=${encodeURIComponent(remoteUrl)}`;
    return this.client
      .getSafe<{
        projectBindings: Array<{ projectId: string; projectKey: string }>;
      }>(endpoint)
      .map((result) => {
        if (!result.response.ok) {
          return undefined;
        }
        if (
          Array.isArray(result.value?.projectBindings) &&
          result.value.projectBindings.length === 0
        ) {
          return null;
        }
        const binding = requireSingleBinding(
          result.value?.projectBindings,
          'git remote on SonarQube Server',
        );
        return binding?.projectKey ? { projectKey: binding.projectKey } : undefined;
      });
  }

  private getSqcProjectIdByRemoteUrl(
    remoteUrl: string,
  ): ResultAsync<string | null | undefined, HttpClientError> {
    const endpoint = `/dop-translation/project-bindings?url=${encodeURIComponent(remoteUrl)}`;
    return this.client
      .getSafe<{ bindings: Array<{ projectId: string }> }>(endpoint)
      .map((result) => {
        if (!result.response.ok) {
          return undefined;
        }
        if (Array.isArray(result.value?.bindings) && result.value.bindings.length === 0) {
          return null;
        }
        const binding = requireSingleBinding(
          result.value?.bindings,
          'git remote on SonarQube Cloud',
        );
        return binding?.projectId;
      });
  }

  /**
   * SonarQube Cloud only: true when the remote is bound to a project that the given organization
   * does not contain. False when there is no binding or the project is in the organization;
   * undefined when the lookup could not tell.
   */
  isGitRemoteBoundOutsideOrg(
    remoteUrl: string,
    orgKey: string,
  ): ResultAsync<boolean | undefined, HttpClientError> {
    if (!this.client.isCloud) {
      return okAsync(false);
    }
    return this.getSqcProjectIdByRemoteUrl(stripGitRemoteUrlUserinfo(remoteUrl)).andThen(
      (projectId) => {
        if (!projectId) {
          return okAsync(projectId === null ? false : undefined);
        }
        return this.searchSonarCloudProjectKeysById(projectId, orgKey).map((keys) =>
          keys === undefined ? undefined : keys.length === 0,
        );
      },
    );
  }

  private getSonarCloudProjectKeyById(
    projectId: string,
    orgKey: string,
  ): ResultAsync<string | null | undefined, HttpClientError> {
    return this.searchSonarCloudProjectKeysById(projectId, orgKey).map(
      (keys) => keys?.[0] || undefined,
    );
  }

  /** Keys of the organization's projects with this id; undefined when the request failed. */
  private searchSonarCloudProjectKeysById(
    projectId: string,
    orgKey: string,
  ): ResultAsync<string[] | undefined, HttpClientError> {
    return this.client
      .getSafe<{ components: Array<{ key: string }> }>('/api/components/search_projects', {
        projectIds: projectId,
        organization: orgKey,
      })
      .map((result) => {
        if (!result.response.ok) {
          return undefined;
        }
        const components = result.value?.components;
        return Array.isArray(components) ? components.map((component) => component.key) : [];
      });
  }

  // ---------------------------------------------------------------------------
  // Admin / CI setup — SonarQube Server only (SQS v2 endpoints)
  // ---------------------------------------------------------------------------

  listGitlabDopSettings(): ResultAsync<
    Array<{ id: string; key: string; url: string }>,
    HttpClientError
  > {
    return this.client
      .get<{
        dopSettings: Array<{ id: string; key: string; type: string; url: string }>;
      }>('/api/v2/dop-translation/dop-settings')
      .map((result) => result.dopSettings.filter((s) => s.type === 'gitlab'));
  }

  // filters by dopSettingId to avoid cross-ALM collisions (GitHub, Azure also populate `repository`)
  getAllProjectBindings(dopSettingId: string): ResultAsync<Map<string, string>, HttpClientError> {
    const pageSize = 500;

    const fetchPage = (
      pageIndex: number,
      bindingMap: Map<string, string>,
    ): ResultAsync<Map<string, string>, HttpClientError> =>
      this.client
        .get<ProjectBindingsPageResponse>('/api/v2/dop-translation/project-bindings', {
          pageSize,
          pageIndex,
          dopSettingId,
        })
        .andThen((result) => {
          mergeBindingsPage(result, bindingMap);
          return isLastPage(result, pageIndex, pageSize)
            ? okAsync(bindingMap)
            : fetchPage(pageIndex + 1, bindingMap);
        });

    return fetchPage(1, new Map<string, string>());
  }
}

interface ProjectBindingsPageResponse {
  projectBindings: Array<{ projectKey: string; repository: string }>;
  page: Paging;
}

function mergeBindingsPage(
  result: ProjectBindingsPageResponse,
  bindingMap: Map<string, string>,
): void {
  for (const binding of result.projectBindings) {
    bindingMap.set(binding.repository, binding.projectKey);
  }
}

function isLastPage(
  result: ProjectBindingsPageResponse,
  pageIndex: number,
  pageSize: number,
): boolean {
  const effectivePageSize = result.page.pageSize || pageSize;
  return (
    result.projectBindings.length === 0 ||
    !hasNextPage({ pageIndex, pageSize: effectivePageSize, total: result.page.total })
  );
}

/** Returns the sole binding, or null when there are none or more than one (ambiguous). */
function requireSingleBinding<T>(bindings: T[] | undefined, context: string): T | null {
  if (!bindings?.length) {
    return null;
  }
  if (bindings.length > 1) {
    logger.debug(
      `Multiple project bindings (${bindings.length}) for ${context}; skipping ambiguous git remote auto-discovery`,
    );
    return null;
  }
  return bindings[0];
}
