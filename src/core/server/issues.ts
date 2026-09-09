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

import { type QueryParams, type SonarHttpClient } from './http-client.ts';
import type { IssuesSearchParams, IssuesSearchResponse } from './types.ts';

/** Booleans where `false` is a meaningful filter value, not "unset". */
const KEYS_WHERE_FALSE_IS_MEANINGFUL = new Set(['resolved', 'asc']);

export class IssuesClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /** Maps an `IssuesSearchParams` key to the wire param name for the current platform. */
  private resolveQueryParamKey(key: string): string {
    switch (key) {
      case 'projects':
        // Cloud has no `projects`/`components` param on this endpoint, only `componentKeys`.
        return this.client.isCloud ? 'componentKeys' : 'components';
      case 'sinceLeakPeriod':
        // `sinceLeakPeriod` was removed on Server 10.0 in favor of `inNewCodePeriod`; Cloud
        // never got the new name. Server 25.1 (our minimum) has had `inNewCodePeriod` since 9.4.
        return this.client.isCloud ? 'sinceLeakPeriod' : 'inNewCodePeriod';
      default:
        return key;
    }
  }

  /**
   * Translates `IssuesSearchParams` into the query params `/api/issues/search` actually
   * accepts, renaming the platform-specific ones (Cloud vs Server).
   */
  private buildSearchQueryParams(params: IssuesSearchParams): QueryParams {
    const queryParams: QueryParams = {};

    Object.entries(params).forEach(([key, value]) => {
      const isSet = KEYS_WHERE_FALSE_IS_MEANINGFUL.has(key) ? value !== undefined : Boolean(value);
      if (isSet) {
        queryParams[this.resolveQueryParamKey(key)] = value as string | number | boolean;
      }
    });

    return queryParams;
  }

  /**
   * Search issues with filters
   */
  async searchIssues(params: IssuesSearchParams): Promise<IssuesSearchResponse> {
    return await this.client.get<IssuesSearchResponse>(
      '/api/issues/search',
      this.buildSearchQueryParams(params),
    );
  }
}
