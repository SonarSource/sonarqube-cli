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
const ISSUE_TYPE_FILTER: Partial<Record<string, string>> = {
  bugs: 'BUG',
  new_bugs: 'BUG',
  reliability_rating: 'BUG',
  new_reliability_rating: 'BUG',
  code_smells: 'CODE_SMELL',
  new_code_smells: 'CODE_SMELL',
  sqale_rating: 'CODE_SMELL',
  new_maintainability_rating: 'CODE_SMELL',
};

/**
 * Several condition pairs (`bugs`/`reliability_rating`, `code_smells`/`sqale_rating`, and their
 * `new_*` equivalents) resolve to byte-identical search params - a gate failing both members of a
 * pair would otherwise fire the same `/api/issues/search` request twice. Keyed by `types` +
 * `sinceLeakPeriod` (the only params that vary by condition within one `attachBreakdowns` call)
 * and shared across the whole call by `attachBreakdowns`.
 */
export type IssuesBreakdownCache = Map<string, Promise<QualityGateMetricBreakdown | undefined>>;

export function fetchIssuesBreakdown(
  issuesClient: IssuesClient,
  params: AttachBreakdownsParams,
  condition: QualityGateConditionSummary,
  cache: IssuesBreakdownCache,
): Promise<QualityGateMetricBreakdown | undefined> {
  const types = ISSUE_TYPE_FILTER[condition.metric];
  const sinceLeakPeriod = isNewCodeMetric(condition.metric);
  const cacheKey = `${types ?? ''}::${sinceLeakPeriod}::${params.componentKey ?? ''}`;

  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const promise = searchIssuesBreakdown(issuesClient, params, condition, types, sinceLeakPeriod);
  cache.set(cacheKey, promise);
  return promise;
}

/** Shared with `security-enrichment.ts`, which resolves its own `types`/`sinceLeakPeriod` and passes `category: 'security'`. */
export async function searchIssuesBreakdown(
  issuesClient: IssuesClient,
  params: AttachBreakdownsParams,
  condition: QualityGateConditionSummary,
  types: string | undefined,
  sinceLeakPeriod: boolean,
  category: 'issues' | 'security' = 'issues',
): Promise<QualityGateMetricBreakdown | undefined> {
  try {
    const searchParams: IssuesSearchParams = {
      projects: params.componentKey ?? params.projectKey,
      organization: params.orgKey,
      types,
      resolved: false,
      sinceLeakPeriod: sinceLeakPeriod || undefined,
      branch: params.branch,
      pullRequest: params.pullRequest,
      s: 'SEVERITY',
      asc: false,
      ps: params.top,
    };
    const { issues, paging } = await issuesClient.searchIssues(searchParams).orThrow();
    const entries = issues.map((issue) => toIssuesEntry(issue, params.projectKey));
    if (entries.length === 0) {
      return undefined;
    }
    return { category, totalCount: paging.total, fetchedCount: issues.length, entries };
  } catch (err) {
    logger.debug(`Failed to build quality gate breakdown for '${condition.metric}'`, err);
    return undefined;
  }
}

/** `component` is `<projectKey>:<path>` - strip the exact project key prefix, since the key
 * itself may contain colons (e.g. Maven's default `groupId:artifactId`). */
function toIssuesEntry(issue: SonarQubeIssue, projectKey: string): IssuesBreakdownEntry {
  const prefix = `${projectKey}:`;
  return {
    file: issue.component.startsWith(prefix)
      ? issue.component.slice(prefix.length)
      : issue.component,
    line: issue.line,
    key: issue.key,
    rule: issue.rule,
    message: issue.message,
  };
}
