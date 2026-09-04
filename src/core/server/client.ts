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

// SonarQube API HTTP client

import { INVOCATION_ID, SONAR_INVOCATION_ID_HEADER } from '@/core/telemetry/invocation-id.ts';

import logger from '../observability/logger.ts';
import { ComponentsClient } from './components.ts';
import { ForbiddenApiError, SqaaForbiddenError } from './errors.ts';
import { SonarHttpClient } from './http-client.ts';
import { type Organization, OrganizationsClient } from './organizations.ts';
import type { SettingsValue } from './settings-value.ts';
import { resolveFromEndpoint } from './sonarcloud-region.ts';

export const GENERIC_HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export const METHODS_WITH_BODY = new Set<HttpMethod>(['POST', 'PATCH', 'PUT']);
export type HttpMethod = (typeof GENERIC_HTTP_METHODS)[number];
export type QueryParams = Record<string, string | number | boolean>;

/**
 * `not_applicable` is returned when Vortex cannot apply to this connection: Cloud without
 * an organization (see `resolveVortexEntitlement`), or a Server missing either hub (HTTP 404).
 */
export type VortexEntitlementStatus =
  'enabled' | 'over_consumption' | 'not_entitled' | 'check_failed' | 'not_applicable';

/**
 * Server has no organizations, but entitlement lives on `/…/{id}` — omitting the
 * segment 404s. The nil UUID is a valid UUID the CLI can send without knowing
 * Server's default-org id (a backend internal). CAG's `@OrganizationId` overwrites
 * it; A3S parses then ignores it.
 */
export const SERVER_ORGANIZATION_ID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

export interface VortexEntitlementResult {
  status: VortexEntitlementStatus;
  consumption?: { consumed: number; limit: number };
}

export interface DopRepository {
  id: string;
  name: string;
  slug: string;
  private: boolean;
  archived: boolean;
  boundProjectIds: string[];
  importedInCurrentOrg: boolean;
}

export interface ProvisionedProject {
  projectKey: string;
}

export class SonarQubeClient extends SonarHttpClient {
  /**
   * Transitional delegation: these domains now live on their own clients, but the
   * command-level callers still on this class have not moved yet. Both this class and
   * these forwards go away once they have.
   */
  private readonly organizations = new OrganizationsClient(this);
  private readonly components = new ComponentsClient(this);

  async getOrganizationLegacyId(organizationKey: string): Promise<string | null> {
    return this.organizations.getOrganizationLegacyId(organizationKey);
  }

  async fetchOrganizationByKey(organizationKey: string): Promise<Organization | undefined> {
    return this.organizations.fetchOrganizationByKey(organizationKey);
  }

  async getOrganizationAlmKey(organizationKey: string): Promise<string | undefined> {
    return this.organizations.getOrganizationAlmKey(organizationKey);
  }

  async hasPrivateProjectsEntitlement(organizationKey: string): Promise<boolean> {
    return this.organizations.hasPrivateProjectsEntitlement(organizationKey);
  }

  async getProjectSettings(projectKey: string): Promise<SettingsValue[]> {
    return this.components.getProjectSettings(projectKey);
  }

  async getComponentId(componentKey: string): Promise<string | null> {
    return this.components.getComponentId(componentKey);
  }

  async checkAiRemediationEntitlement(
    orgKey: string,
  ): Promise<{ status: 'not_eligible' | 'not_enabled' | 'ok' | 'unknown' }> {
    try {
      const orgsEndpoint = '/organizations/organizations';
      const orgs = await this.get<Array<{ id: string; uuidV4: string; name?: string }>>(
        orgsEndpoint,
        { organizationKey: orgKey, excludeEligibility: 'true' },
        resolveFromEndpoint(this.serverURL, orgsEndpoint),
      );
      const org = orgs.at(0);
      if (!org) return { status: 'not_eligible' };

      const configEndpoint = `/fix-suggestions/organization-configs/${org.id}`;
      const config = await this.get<{
        codeReviewAgent: { organizationEligible: boolean; delegateIssuesEnabled?: boolean };
      }>(configEndpoint, undefined, resolveFromEndpoint(this.serverURL, configEndpoint));

      if (!config.codeReviewAgent.organizationEligible) return { status: 'not_eligible' };
      if (!config.codeReviewAgent.delegateIssuesEnabled) return { status: 'not_enabled' };
      return { status: 'ok' };
    } catch (err) {
      logger.warn('AI remediation entitlement check failed', err);
      return { status: 'unknown' };
    }
  }

  /** Server-enforced max `pageSize` for `/dop-translation/dop-repositories`. */
  static readonly DOP_REPOSITORIES_MAX_PAGE_SIZE = 50;

  /**
   * Fetch one page of repositories visible to an organization's bound DevOps platform via
   * `/dop-translation/dop-repositories` (SonarQube Cloud only, region-specific API host).
   */
  async fetchDopRepositoriesPage(
    organizationId: string,
    pageIndex: number,
    pageSize: number,
  ): Promise<{ repositories: DopRepository[]; total: number }> {
    const endpoint = '/dop-translation/dop-repositories';
    const result = await this.get<{
      repositories: DopRepository[];
      page: { total: number };
    }>(
      endpoint,
      { organizationId, pageIndex, pageSize },
      resolveFromEndpoint(this.serverURL, endpoint),
    );
    return { repositories: result.repositories, total: result.page.total };
  }

  /**
   * Create (provision) a SonarQube project bound to a single DevOps platform repository via the
   * legacy `POST /api/alm_integration/provision_projects` endpoint (SonarQube Cloud only). This
   * has not migrated to the newer `dop-translation` family yet.
   *
   * `installationKey` must already be in the ALM-specific format the server expects (e.g.
   * `<slug>|<id>` for GitHub, plain `id` for other platforms).
   */
  async provisionProject(
    organization: string,
    installationKey: string,
  ): Promise<{ projects: ProvisionedProject[] }> {
    return await this.postFormJson<{ projects: ProvisionedProject[] }>(
      '/api/alm_integration/provision_projects',
      { organization, installationKeys: installationKey },
    );
  }

  /**
   * Request SonarQube Cloud Autoscan eligibility/auto-enable for a newly provisioned project.
   * Best-effort: swallows failures so a hiccup here never fails the enclosing `sonar import` run.
   */
  async requestAutoscanEligibility(projectKey: string): Promise<void> {
    try {
      await this.get('/api/autoscan/eligibility', {
        autoEnable: true,
        ignoreCache: false,
        projectKey,
      });
    } catch (err) {
      logger.debug('Failed to request autoscan eligibility', err);
      return undefined;
    }
  }

  /**
   * Schedule an AI agent remediation job for a set of issues.
   * SonarQube Cloud only - endpoint lives on the region-specific API host.
   */
  async scheduleAgentJob(request: AgentJobRequest): Promise<AgentJobResponse> {
    const endpoint = '/fix-suggestions/ai-agent-scheduled-jobs';
    return await this.post<AgentJobResponse>(
      endpoint,
      request,
      resolveFromEndpoint(this.serverURL, endpoint),
    );
  }

  /**
   * Create a Vortex analysis (single- or multi-file). On Cloud the endpoint lives on the
   * region-specific API host; on Server the A3S hub serves it from the instance itself.
   */
  async createAnalysis(request: SqaaAnalysisRequest): Promise<SqaaAnalysisResponse> {
    const endpoint = this.isCloud ? '/a3s-analysis/analyses' : '/api/v2/a3s/analyses';
    try {
      return await this.post<SqaaAnalysisResponse>(
        endpoint,
        request,
        resolveFromEndpoint(this.serverURL, endpoint),
        { [SONAR_INVOCATION_ID_HEADER]: INVOCATION_ID },
      );
    } catch (err) {
      // 403 on this endpoint means Agentic Pack entitlement was revoked.
      if (err instanceof ForbiddenApiError) {
        throw new SqaaForbiddenError();
      }
      throw err;
    }
  }
}

export interface AgentJobRequest {
  projectId: string;
  issueKeys: string[];
  triggerSource: 'CLI';
}

export interface AgentJobResponse {
  taskId: string;
}

export type SqaaAnalysisDepth = 'STANDARD' | 'DEEP';

export type SqaaFileScope = 'MAIN' | 'TEST';

export interface SqaaAnalysisFile {
  path: string;
  content: string;
  scope?: SqaaFileScope;
}

export interface SqaaAnalysisRequest {
  /** Cloud-only: the Server hub forces the request onto the instance's default organization. */
  organizationKey?: string;
  projectKey: string;
  branchName?: string;
  files: SqaaAnalysisFile[];
  analysisDepth?: SqaaAnalysisDepth;
}

export interface SqaaAnalysisResponse {
  id: string;
  issues: SqaaIssue[];
  patchResult?: {
    newIssues: SqaaIssue[];
    matchedIssues: SqaaIssue[];
    closedIssues: string[];
  } | null;
  errors?: Array<{ code: string; message: string }> | null;
}

export interface SqaaIssue {
  id: string;
  filePath?: string | null;
  message: string;
  rule: string;
  textRange?: {
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
  } | null;
  flows?: Array<{
    type: string;
    description?: string | null;
    locations: Array<{
      textRange?: { startLine: number; endLine: number } | null;
      message?: string | null;
      file?: string | null;
    }>;
  }> | null;
}
