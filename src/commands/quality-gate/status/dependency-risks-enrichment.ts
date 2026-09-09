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

import type {
  ScaIssueType,
  Severity,
} from '@/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import { ISSUE_TYPES } from '@/commands/analyze/dependency-risk-helpers/view-model/build/issue-types.ts';
import { SEVERITIES } from '@/commands/analyze/dependency-risk-helpers/view-model/build/severity.ts';
import logger from '@/core/observability/logger.ts';
import { isNewCodeMetric } from '@/core/server/measures.ts';
import { ScaClient } from '@/core/server/sca.ts';
import type { ScaIssueRelease } from '@/core/server/types.ts';

import type { AttachBreakdownsParams } from './breakdown.ts';
import type {
  DependencyRiskBreakdownEntry,
  QualityGateConditionSummary,
  QualityGateMetricBreakdown,
} from './condition-summary.ts';

const RISK_TYPES_BY_METRIC_SUFFIX: Record<string, ScaIssueType[]> = {
  any_issue: ['MALWARE', 'PROHIBITED_LICENSE', 'VULNERABILITY'],
  any_security: ['MALWARE', 'VULNERABILITY'],
  licensing: ['PROHIBITED_LICENSE'],
  malware: ['MALWARE'],
  vulnerability: ['VULNERABILITY'],
};

function resolveRiskTypes(metricKey: string): ScaIssueType[] | undefined {
  const suffix = metricKey.replace(/^new_/, '').replace(/^sca_(?:count|rating|severity)_/, '');
  return RISK_TYPES_BY_METRIC_SUFFIX[suffix];
}

export async function fetchDependencyRisksBreakdown(
  params: AttachBreakdownsParams,
  condition: QualityGateConditionSummary,
): Promise<QualityGateMetricBreakdown | undefined> {
  const types = resolveRiskTypes(condition.metric);
  if (!types) {
    return undefined;
  }
  try {
    const scaClient = new ScaClient(params.client);
    const { issuesReleases, totalCount } = await scaClient
      .getWorstIssuesReleases({
        projectKey: params.projectKey,
        types,
        newlyIntroduced: isNewCodeMetric(condition.metric),
        top: params.top,
        branch: params.branch,
        pullRequest: params.pullRequest,
        orgKey: params.orgKey,
      })
      .orThrow();
    const entries = issuesReleases
      .map(toBreakdownEntry)
      .filter((entry): entry is DependencyRiskBreakdownEntry => entry !== undefined);
    if (entries.length === 0) {
      return undefined;
    }
    return {
      category: 'dependency-risks',
      totalCount,
      fetchedCount: entries.length,
      entries,
    };
  } catch (error) {
    logger.debug(`Failed to build quality gate breakdown for '${condition.metric}'`, error);
    return undefined;
  }
}

function toBreakdownEntry(issueRelease: ScaIssueRelease): DependencyRiskBreakdownEntry | undefined {
  const severity = issueRelease.severity as Severity;
  const type = issueRelease.type as ScaIssueType;
  if (!SEVERITIES.includes(severity) || !ISSUE_TYPES.includes(type)) {
    logger.debug(
      `Skipping dependency risk '${issueRelease.key}' with unrecognized severity '${issueRelease.severity}' or type '${issueRelease.type}'`,
    );
    return undefined;
  }
  return {
    package: issueRelease.release.packageName,
    version: issueRelease.release.version,
    severity,
    type,
    key: issueRelease.key,
    vulnerabilityId: issueRelease.vulnerabilityId ?? undefined,
  };
}
