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

// The SonarQube Server API calls `sonar import` makes against a DevOps platform setting.
// None of them returns or accepts a personal access token: the CLI only asks the server
// whether the caller has a usable one.

import type { HttpClientError } from '@/core/server/errors.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';

import { type PatStatus, patStatusFromError } from './pat-status.ts';

/** DevOps platform kinds as `dop-settings` reports them (`bitbucket` is Bitbucket Server). */
const DOP_PLATFORMS = ['github', 'gitlab', 'azure', 'bitbucket', 'bitbucketcloud'] as const;

export type DopPlatform = (typeof DOP_PLATFORMS)[number];

export interface DopSetting {
  id: string;
  key: string;
  type: DopPlatform;
  url?: string;
}

/**
 * Outcome of a token probe. `organizationCount` is only set by the GitHub probe, from the
 * listing a `valid` token returned; it is absent when the response carried no listing to count.
 */
export interface PatProbe {
  status: PatStatus;
  organizationCount?: number;
}

interface DopSettingsResponse {
  dopSettings: Array<{ id: string; key: string; type: string; url?: string | null }>;
}

function isDopPlatform(type: string): type is DopPlatform {
  return (DOP_PLATFORMS as readonly string[]).includes(type);
}

export class ServerImportApiClient {
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
  }

  /** The configured DevOps platform settings; kinds this CLI does not know are left out. */
  async listDopSettings(): Promise<DopSetting[]> {
    const response = await this.client
      .get<DopSettingsResponse>('/api/v2/dop-translation/dop-settings')
      .orThrow();
    return response.dopSettings.flatMap(({ id, key, type, url }) =>
      isDopPlatform(type) ? [{ id, key, type, ...(url ? { url } : {}) }] : [],
    );
  }

  /** PAT status through `check_pat`, which every platform supports except GitHub. */
  async checkPat(settingKey: string): Promise<PatStatus> {
    return this.patStatusOf('/api/alm_integrations/check_pat', settingKey);
  }

  /**
   * PAT status for GitHub, which `check_pat` rejects: listing the user's organizations needs the
   * stored token. GitHub's rejection of a dead token is not an HTTP error there, so a successful
   * listing does not prove the token works: it comes back empty, which `organizationCount` exposes.
   * An empty listing is inconclusive (a dead token, or a valid one with no installation).
   */
  async probeGithubPat(settingKey: string): Promise<PatProbe> {
    return this.client
      .getAllowEmptyBody<{
        organizations?: unknown[];
        paging?: { total?: number };
      }>('/api/alm_integrations/list_github_organizations', { almSetting: settingKey })
      .match(
        (response): PatProbe => ({
          status: 'valid',
          organizationCount: countOrganizations(response),
        }),
        (error): PatProbe => ({ status: patStatusOfFailure(error) }),
      );
  }

  private patStatusOf(endpoint: string, settingKey: string): Promise<PatStatus> {
    return this.client
      .getAllowEmptyBody(endpoint, { almSetting: settingKey })
      .match(() => 'valid', patStatusOfFailure);
  }
}

function patStatusOfFailure(error: HttpClientError): PatStatus {
  const status = patStatusFromError(error);
  if (status === undefined) throw error;
  return status;
}

function countOrganizations(
  response:
    | {
        organizations?: unknown[];
        paging?: { total?: number };
      }
    | undefined,
): number | undefined {
  if (response === undefined || !Array.isArray(response.organizations)) return undefined;
  const total = response.paging?.total;
  return typeof total === 'number'
    ? Math.max(total, response.organizations.length)
    : response.organizations.length;
}
