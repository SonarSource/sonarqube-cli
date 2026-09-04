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

// SonarQube Quality Gates API wrapper

import { type SonarHttpClient } from './http-client.ts';
import type { ProjectStatus, ProjectStatusParams, ProjectStatusResponse } from './types.ts';

export class QualityGatesClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Fetch the quality gate status for a project. Returns `null` when the project (or the
   * requested branch/pull request) has no analysis yet — the server responds 404 for that case,
   * distinct from `status: 'NONE'` which the server returns for an analyzed project with no
   * quality gate associated. Callers treat both as "not computed".
   */
  async getProjectStatus(params: ProjectStatusParams): Promise<ProjectStatus | null> {
    const queryParams: Record<string, string> = { projectKey: params.projectKey };
    if (params.branch) {
      queryParams.branch = params.branch;
    }
    if (params.pullRequest) {
      queryParams.pullRequest = params.pullRequest;
    }
    const result = await this.client.getOrNotFound<ProjectStatusResponse>(
      '/api/qualitygates/project_status',
      queryParams,
    );
    return result?.projectStatus ?? null;
  }
}
