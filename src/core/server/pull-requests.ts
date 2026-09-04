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

// SonarQube Project Pull Requests API wrapper

import { type SonarHttpClient } from './http-client.ts';
import type { ProjectPullRequest, ProjectPullRequestsResponse } from './types.ts';

export class PullRequestsClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  // Returns null on a 404 (edition without PR analysis) instead of throwing.
  async listPullRequests(projectKey: string): Promise<ProjectPullRequest[] | null> {
    const result = await this.client.getOrNotFound<ProjectPullRequestsResponse>(
      '/api/project_pull_requests/list',
      { project: projectKey },
    );
    return result?.pullRequests ?? null;
  }
}
