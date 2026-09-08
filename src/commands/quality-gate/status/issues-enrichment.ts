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

// Builds the issues-category breakdown (Issues, Reliability and Maintainability domains)

import logger from '@/core/observability/logger.ts';
import type { IssuesClient } from '@/core/server/issues.ts';
import { isNewCodeMetric } from '@/core/server/measures.ts';
import type { IssuesSearchParams, SonarQubeIssue } from '@/core/server/types.ts';

import type { AttachBreakdownsParams } from './breakdown.ts';
import type {
  IssuesBreakdownEntry,
  QualityGateConditionSummary,
  QualityGateMetricBreakdown,
} from './condition-summary.ts';

/** Reliability and Maintainability conditions restrict enrichment to their own issue type; generic violations are unfiltered. */
const ISSUE_TYPE_FILTER: Record<string, string> = {
  bugs: 'BUG',
  new_bugs: 'BUG',
  reliability_rating: 'BUG',
  new_reliability_rating: 'BUG',
  code_smells: 'CODE_SMELL',
  new_code_smells: 'CODE_SMELL',
  sqale_rating: 'CODE_SMELL',
  new_maintainability_rating: 'CODE_SMELL',
};

export async function fetchIssuesBreakdown(
  issuesClient: IssuesClient,
  params: AttachBreakdownsParams,
  condition: QualityGateConditionSummary,
): Promise<QualityGateMetricBreakdown | undefined> {
  try {
    const searchParams: IssuesSearchParams = {
      projects: params.projectKey,
      organization: params.orgKey,
      types: ISSUE_TYPE_FILTER[condition.metric],
      resolved: false,
      sinceLeakPeriod: isNewCodeMetric(condition.metric) || undefined,
      branch: params.branch,
      pullRequest: params.pullRequest,
      s: 'SEVERITY',
      asc: false,
      ps: params.top,
    };
    const { issues, paging } = await issuesClient.searchIssues(searchParams);
    const entries = issues.map(toIssuesEntry);
    if (entries.length === 0) {
      return undefined;
    }
    return { category: 'issues', totalCount: paging.total, fetchedCount: issues.length, entries };
  } catch (err) {
    logger.debug(`Failed to build quality gate breakdown for '${condition.metric}'`, err);
    return undefined;
  }
}

/** `component` is `<projectKey>:<path>` - the project key prefix isn't useful in the breakdown. */
function toIssuesEntry(issue: SonarQubeIssue): IssuesBreakdownEntry {
  const separatorIndex = issue.component.indexOf(':');
  return {
    file: separatorIndex === -1 ? issue.component : issue.component.slice(separatorIndex + 1),
    line: issue.line,
    key: issue.key,
    rule: issue.rule,
    message: issue.message,
  };
}
