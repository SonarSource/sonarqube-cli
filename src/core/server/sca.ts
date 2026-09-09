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

// Sonar Advanced Security (SCA) feature-enablement API wrapper.

import { okAsync, type ResultAsync } from '../result.ts';
import type { HttpClientError } from './errors.ts';
import type { QueryParams, SonarHttpClient } from './http-client.ts';
import type { ScaIssueRelease, ScaIssuesReleasesResponse } from './types.ts';

export type ScaEnablement = 'enabled' | 'not_enabled' | 'check_failed';

export interface GetWorstIssuesReleasesParams {
  projectKey: string;
  types: string[];
  newlyIntroduced?: boolean;
  top: number;
  branch?: string;
  pullRequest?: string;
  orgKey?: string;
}

export interface GetWorstIssuesReleasesResult {
  issuesReleases: ScaIssueRelease[];
  totalCount: number;
}

export class ScaClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /**
   * Query Sonar Advanced Security (SCA) enablement on the connected server.
   * SonarCloud exposes this at `/sca/feature-enabled?organization=<key>`
   * (api.sonarcloud.io); SonarQube Server at `/api/v2/sca/feature-enabled`.
   *
   * Returns a 3-state value so callers can distinguish "not enabled" (a definitive
   * answer from the server) from "check_failed" (network error, unreachable, etc.).
   * Never resolves to `Err`: every failure is folded into the `'check_failed'` value.
   */
  getScaEnablement(
    connectionType: 'cloud' | 'on-premise',
    orgKey?: string,
  ): ResultAsync<ScaEnablement, never> {
    const isCloud = connectionType === 'cloud';
    const endpoint = isCloud ? '/sca/feature-enabled' : '/api/v2/sca/feature-enabled';
    const params = isCloud && orgKey ? { organization: orgKey } : undefined;
    return this.client
      .get<{ enabled: boolean }>(endpoint, params, this.client.apiHostFor(endpoint))
      .map((result): ScaEnablement => (result.enabled ? 'enabled' : 'not_enabled'))
      .orElse(() => okAsync<ScaEnablement>('check_failed'));
  }

  /**
   * Boolean wrapper over getScaEnablement for callers that gate on "enabled" only.
   * Any failure (404, network, unauthorized, not enabled) is treated as "not available".
   */
  checkScaEnabled(
    connectionType: 'cloud' | 'on-premise',
    orgKey?: string,
  ): ResultAsync<boolean, never> {
    return this.getScaEnablement(connectionType, orgKey).map(
      (enablement) => enablement === 'enabled',
    );
  }

  getWorstIssuesReleases(
    params: GetWorstIssuesReleasesParams,
  ): ResultAsync<GetWorstIssuesReleasesResult, HttpClientError> {
    const endpoint = this.client.isCloud ? '/sca/issues-releases' : '/api/v2/sca/issues-releases';
    const queryParams: QueryParams = {
      projectKey: params.projectKey,
      types: params.types.join(','),
      statuses: 'OPEN,CONFIRM',
      sort: '-severity',
      pageSize: params.top,
    };
    if (this.client.isCloud && params.orgKey) {
      queryParams.organization = params.orgKey;
    }
    if (params.newlyIntroduced) {
      queryParams.newlyIntroduced = true;
    }
    if (params.branch) {
      queryParams.branchKey = params.branch;
    }
    if (params.pullRequest) {
      queryParams.pullRequestKey = params.pullRequest;
    }
    return this.client
      .get<ScaIssuesReleasesResponse>(endpoint, queryParams, this.client.apiHostFor(endpoint))
      .map((response) => ({
        issuesReleases: response.issuesReleases,
        totalCount: response.page.total,
      }));
  }
}
