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

import type { SonarHttpClient } from './http-client.ts';
import type { SettingsValue } from './settings-value.ts';

export class ComponentsClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Check if component (project) exists
   */
  async checkComponent(projectKey: string): Promise<boolean> {
    try {
      await this.client.get('/api/components/show', { component: projectKey });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Like `checkComponent`, but only treats a 404 as "missing" - every other
   * failure (auth, rate limit, outage, network error) propagates as its
   * normal typed error instead of being reported as a missing component.
   */
  async componentExists(projectKey: string): Promise<boolean> {
    const component = await this.client.getOrNotFound('/api/components/show', {
      component: projectKey,
    });
    return component !== null;
  }

  /**
   * Return the legacy alphanumeric ID for a project component key.
   * The external AI agents API expects this ID (not the human-readable key) as `projectId`.
   * Uses /api/navigation/component - same endpoint the web UI uses; `id` is always present there.
   */
  async getComponentId(componentKey: string): Promise<string | null> {
    try {
      const result = await this.client.get<{ id: string }>('/api/navigation/component', {
        component: componentKey,
      });
      return result.id;
    } catch {
      return null;
    }
  }

  async hasProjectBeenAnalyzed(projectKey: string): Promise<boolean> {
    const result = await this.client.getOrNotFound<{ analyses?: unknown[] }>(
      '/api/project_analyses/search',
      { project: projectKey, ps: 1 },
    );
    return (result?.analyses?.length ?? 0) > 0;
  }

  /**
   * Fetch project-scoped settings via `/api/settings/values`. The `component`
   * query param scopes the values to a specific project; without it the API
   * returns global defaults. Callers project the raw entries into whatever
   * shape they need (e.g. `parseAnalysisProperties` for SCA).
   */
  async getProjectSettings(projectKey: string): Promise<SettingsValue[]> {
    const result = await this.client.getOrNotFound<{ settings?: SettingsValue[] }>(
      '/api/settings/values',
      { component: projectKey },
    );

    if (result === null) {
      throw new Error(`Project '${projectKey}' not found`);
    }

    return result.settings ?? [];
  }
}
