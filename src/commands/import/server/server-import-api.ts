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

export const DOP_PLATFORM_LABELS: Record<DopPlatform, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  azure: 'Azure DevOps',
  bitbucket: 'Bitbucket Server',
  bitbucketcloud: 'Bitbucket Cloud',
};

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

/** A GitLab project as `search_gitlab_repos` returns it; `sqProjectKey` is set once it is bound. */
export interface GitlabRepositoryResponse {
  id: number | string;
  name: string;
  pathName?: string;
  slug: string;
  pathSlug?: string;
  sqProjectKey?: string;
}

/** An Azure DevOps project as `list_azure_projects` returns it. */
export interface AzureProjectResponse {
  name: string;
  description?: string;
}

/** An Azure DevOps repository as `search_azure_repos` returns it; `sqProjectKey` is set once bound. */
export interface AzureRepositoryResponse {
  name: string;
  projectName: string;
  sqProjectKey?: string;
  sqProjectName?: string;
}

/** A Bitbucket Cloud repository as `search_bitbucketcloud_repos` returns it; `sqProjectKey` is set once it is bound. */
export interface BitbucketCloudRepositoryResponse {
  slug: string;
  uuid: string;
  name: string;
  workspace: string;
  sqProjectKey?: string;
}

export interface BoundProjectRequest {
  projectKey: string;
  projectName: string;
  devOpsPlatformSettingId: string;
  repositoryIdentifier: string;
  /** Needed for Azure DevOps and Bitbucket Server only. */
  projectIdentifier?: string;
}

export class ServerImportApiClient {
  /** Server-enforced max `ps` for the `search_*_repos` endpoints. */
  static readonly SEARCH_MAX_PAGE_SIZE = 100;

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
      .get<{
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

  /** One page of the GitLab projects the caller's token can see (`pageIndex` starts at 1). */
  async searchGitlabRepos(
    settingKey: string,
    pageIndex: number,
    pageSize: number,
  ): Promise<{ repositories: GitlabRepositoryResponse[]; total?: number }> {
    const response = await this.client
      .get<{
        repositories?: GitlabRepositoryResponse[];
        paging?: { total?: number };
      }>('/api/alm_integrations/search_gitlab_repos', {
        almSetting: settingKey,
        p: pageIndex,
        ps: pageSize,
      })
      .orThrow();
    return { repositories: response.repositories ?? [], total: response.paging?.total };
  }

  /** Every Azure DevOps project the caller's token can see; the endpoint is not paged. */
  async listAzureProjects(settingKey: string): Promise<AzureProjectResponse[]> {
    const response = await this.client
      .get<{ projects?: AzureProjectResponse[] }>('/api/alm_integrations/list_azure_projects', {
        almSetting: settingKey,
      })
      .orThrow();
    return response.projects ?? [];
  }

  /** Every repository of one Azure DevOps project; the endpoint is not paged. */
  async searchAzureRepos(
    settingKey: string,
    projectName: string,
  ): Promise<AzureRepositoryResponse[]> {
    const response = await this.client
      .get<{ repositories?: AzureRepositoryResponse[] }>(
        '/api/alm_integrations/search_azure_repos',
        { almSetting: settingKey, projectName },
      )
      .orThrow();
    return response.repositories ?? [];
  }

  /**
   * One page of the Bitbucket Cloud repositories of the setting's workspace, which the server
   * resolves itself (`pageIndex` starts at 1). The response carries no total.
   */
  async searchBitbucketCloudRepos(
    settingKey: string,
    pageIndex: number,
    pageSize: number,
  ): Promise<{ repositories: BitbucketCloudRepositoryResponse[] }> {
    const response = await this.client
      .get<{ repositories?: BitbucketCloudRepositoryResponse[] }>(
        '/api/alm_integrations/search_bitbucketcloud_repos',
        { almSetting: settingKey, p: pageIndex, ps: pageSize },
      )
      .orThrow();
    return { repositories: response.repositories ?? [] };
  }

  /**
   * Creates the project and binds it to the repository, or updates the binding when a project
   * with that key already exists (the endpoint is idempotent). `newProjectCreated` tells which.
   */
  async putBoundProject(request: BoundProjectRequest): Promise<{ newProjectCreated: boolean }> {
    const response = await this.client
      .put<{ newProjectCreated?: boolean }>('/api/v2/dop-translation/bound-projects', {
        ...request,
        monorepo: false,
      })
      .orThrow();
    return { newProjectCreated: response.newProjectCreated ?? true };
  }

  private patStatusOf(endpoint: string, settingKey: string): Promise<PatStatus> {
    return this.client
      .get<unknown>(endpoint, { almSetting: settingKey })
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
