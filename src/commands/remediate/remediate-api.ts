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

// Every SonarQube API call `sonar remediate` makes, in one place next to the command.

import logger from '@/core/observability/logger.ts';
import { unwrap } from '@/core/result.ts';
import { ComponentsClient } from '@/core/server/components.ts';
import { type SonarHttpClient } from '@/core/server/http-client.ts';
import { IssuesClient } from '@/core/server/issues.ts';

export interface AgentJobRequest {
  projectId: string;
  issueKeys: string[];
  triggerSource: 'CLI';
}

export interface AgentJobResponse {
  taskId: string;
}

export type AiRemediationEntitlement = 'not_eligible' | 'not_enabled' | 'ok' | 'unknown';

export class RemediateApiClient {
  /** Shared APIs this command drives directly, exposed rather than re-declared. */
  readonly issues: IssuesClient;
  readonly components: ComponentsClient;
  private readonly client: SonarHttpClient;

  constructor(client: SonarHttpClient) {
    this.client = client;
    this.components = new ComponentsClient(client);
    this.issues = new IssuesClient(client);
  }

  async checkAiRemediationEntitlement(
    orgKey: string,
  ): Promise<{ status: AiRemediationEntitlement }> {
    // Not OrganizationsClient.getOrganizationLegacyId: it maps a failed lookup to null,
    // which would report an unreachable server as 'not_eligible' instead of 'unknown'.
    const orgsEndpoint = '/organizations/organizations';
    const orgsResult = await this.client.get<Array<{ id: string; uuidV4: string; name?: string }>>(
      orgsEndpoint,
      { organizationKey: orgKey, excludeEligibility: 'true' },
      this.client.apiHostFor(orgsEndpoint),
    );
    if (!orgsResult.ok) {
      logger.warn('AI remediation entitlement check failed', orgsResult.error);
      return { status: 'unknown' };
    }
    const org = orgsResult.value.at(0);
    if (!org) return { status: 'not_eligible' };

    const configEndpoint = `/fix-suggestions/organization-configs/${org.id}`;
    const configResult = await this.client.get<{
      codeReviewAgent: { organizationEligible: boolean; delegateIssuesEnabled?: boolean };
    }>(configEndpoint, undefined, this.client.apiHostFor(configEndpoint));
    if (!configResult.ok) {
      logger.warn('AI remediation entitlement check failed', configResult.error);
      return { status: 'unknown' };
    }

    if (!configResult.value.codeReviewAgent.organizationEligible) return { status: 'not_eligible' };
    if (!configResult.value.codeReviewAgent.delegateIssuesEnabled) return { status: 'not_enabled' };
    return { status: 'ok' };
  }

  /**
   * Schedule an AI agent remediation job for a set of issues.
   * SonarQube Cloud only - endpoint lives on the region-specific API host.
   */
  async scheduleAgentJob(request: AgentJobRequest): Promise<AgentJobResponse> {
    const endpoint = '/fix-suggestions/ai-agent-scheduled-jobs';
    return unwrap(
      await this.client.post<AgentJobResponse>(endpoint, request, this.client.apiHostFor(endpoint)),
    );
  }
}
