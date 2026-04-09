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

// SonarQube Issues API wrapper

import { type SonarQubeClient } from './client.js';
import type { IssuesSearchParams, IssuesSearchResponse } from '../lib/types.js';

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

    Object.entries(params).forEach(([key, value]) => {
      if (key === 'projects' && value) {
        const projectParamKey = this.client.isCloud ? 'projects' : 'components';
        queryParams[projectParamKey] = value as string;
      } else if (key === 'resolved' && value !== undefined) {
        queryParams.resolved = value as boolean;
      } else if (value) {
        queryParams[key] = value as string | number | boolean;
      }
    });

    return await this.client.get<IssuesSearchResponse>('/api/issues/search', queryParams);
  }
}
