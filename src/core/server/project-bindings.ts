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
import { stripGitRemoteUrlUserinfo } from './git-remote-url.ts';
import type { SonarHttpClient } from './http-client.ts';

export class ProjectBindingsClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Resolve a project key from a git repository remote URL using server-side bindings.
   * SonarQube Server: GET /api/v2/dop-translation/project-bindings
   * SonarQube Cloud: GET /dop-translation/project-bindings, then search_projects by project id.
   */
  async getProjectKeyByGitRemote(remoteUrl: string, orgKey?: string): Promise<string | null> {
    const sanitizedRemoteUrl = stripGitRemoteUrlUserinfo(remoteUrl);
    if (this.client.isCloud) {
      if (!orgKey) {
        return null;
      }
      const projectId = await this.getSqcProjectIdByRemoteUrl(sanitizedRemoteUrl);
      if (!projectId) {
        return null;
      }
      return this.getSonarCloudProjectKeyById(projectId, orgKey);
    }
    const binding = await this.getSqsProjectBindingByRemoteUrl(sanitizedRemoteUrl);
    return binding?.projectKey ?? null;
  }

  private async getSqsProjectBindingByRemoteUrl(
    remoteUrl: string,
  ): Promise<{ projectKey: string } | null> {
    const endpoint = `/api/v2/dop-translation/project-bindings?repositoryUrl=${encodeURIComponent(remoteUrl)}`;
    const result = await this.client.getSafe<{
      projectBindings: Array<{ projectId: string; projectKey: string }>;
    }>(endpoint);
    if (!result.response.ok) {
      return null;
    }
    const binding = requireSingleBinding(
      result.value?.projectBindings,
      'git remote on SonarQube Server',
    );
    return binding?.projectKey ? { projectKey: binding.projectKey } : null;
  }

  private async getSqcProjectIdByRemoteUrl(remoteUrl: string): Promise<string | null> {
    const endpoint = `/dop-translation/project-bindings?url=${encodeURIComponent(remoteUrl)}`;
    const result = await this.client.getSafe<{ bindings: Array<{ projectId: string }> }>(
      endpoint,
      undefined,
      this.client.apiHostFor(endpoint),
    );
    if (!result.response.ok) {
      return null;
    }
    const binding = requireSingleBinding(result.value?.bindings, 'git remote on SonarQube Cloud');
    return binding?.projectId ?? null;
  }

  private async getSonarCloudProjectKeyById(
    projectId: string,
    orgKey: string,
  ): Promise<string | null> {
    const result = await this.client.getSafe<{ components: Array<{ key: string }> }>(
      '/api/components/search_projects',
      { projectIds: projectId, organization: orgKey },
    );
    if (!result.response.ok) {
      return null;
    }
    const components = result.value?.components;
    if (!Array.isArray(components) || components.length === 0) {
      return null;
    }
    const projectKey = components[0].key;
    return projectKey || null;
  }

  // ---------------------------------------------------------------------------
  // Admin / CI setup — SonarQube Server only (SQS v2 endpoints)
  // ---------------------------------------------------------------------------

  async listGitlabDopSettings(): Promise<Array<{ id: string; key: string; url: string }>> {
    const result = await this.client.get<{
      dopSettings: Array<{ id: string; key: string; type: string; url: string }>;
    }>('/api/v2/dop-translation/dop-settings');
    return result.dopSettings.filter((s) => s.type === 'gitlab');
  }

  // filters by dopSettingId to avoid cross-ALM collisions (GitHub, Azure also populate `repository`)
  async getAllProjectBindings(dopSettingId: string): Promise<Map<string, string>> {
    const bindingMap = new Map<string, string>();
    let pageIndex = 1;
    const pageSize = 500;
    for (;;) {
      const result = await this.client.get<{
        projectBindings: Array<{ projectKey: string; repository: string }>;
        page: { total: number; pageSize: number; pageIndex: number };
      }>('/api/v2/dop-translation/project-bindings', {
        pageSize,
        pageIndex,
        dopSettingId,
      });
      for (const binding of result.projectBindings) {
        bindingMap.set(binding.repository, binding.projectKey);
      }
      const effectivePageSize = result.page.pageSize || pageSize;
      if (result.projectBindings.length === 0 || pageIndex * effectivePageSize >= result.page.total)
        break;
      pageIndex++;
    }
    return bindingMap;
  }
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
