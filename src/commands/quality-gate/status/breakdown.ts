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

// Builds the per-file breakdown for failing quality gate conditions

import logger from '@/core/observability/logger.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { IssuesClient } from '@/core/server/issues.ts';
import { MeasuresClient } from '@/core/server/measures.ts';
import type { Metric, QualityGateCondition } from '@/core/server/types.ts';

import type {
  QualityGateConditionSummary,
  QualityGateMetricBreakdown,
} from './condition-summary.ts';
import { fetchDependencyRisksBreakdown } from './dependency-risks-enrichment.ts';
import { fetchDuplicationsBreakdown } from './duplications-enrichment.ts';
import type { IssuesBreakdownCache } from './issues-enrichment.ts';
import { fetchIssuesBreakdown } from './issues-enrichment.ts';
import type { SecurityBreakdownCache } from './security-enrichment.ts';
import { fetchSecurityBreakdown } from './security-enrichment.ts';
import { fetchWorstFileEntries } from './worst-file-entries.ts';

const DEPENDENCY_RISK_KINDS = [
  'any_issue',
  'any_security',
  'licensing',
  'malware',
  'vulnerability',
];
const DEPENDENCY_RISK_METRICS = DEPENDENCY_RISK_KINDS.flatMap((kind) => [
  `sca_count_${kind}`,
  `sca_rating_${kind}`,
  `sca_severity_${kind}`,
  `new_sca_count_${kind}`,
  `new_sca_rating_${kind}`,
  `new_sca_severity_${kind}`,
]);

/** Metric keys owned by each `--category` value, both overall and new-code variants. */
const CATEGORY_METRICS: Record<string, string[]> = {
  coverage: [
    'coverage',
    'branch_coverage',
    'line_coverage',
    'new_coverage',
    'new_branch_coverage',
    'new_line_coverage',
  ],
  duplications: [
    'duplicated_lines_density',
    'duplicated_blocks',
    'duplicated_files',
    'duplicated_lines',
    'new_duplicated_lines_density',
    'new_duplicated_blocks',
    'new_duplicated_lines',
  ],
  issues: [
    'violations',
    'new_violations',
    'bugs',
    'new_bugs',
    'reliability_rating',
    'new_reliability_rating',
    'code_smells',
    'new_code_smells',
    'sqale_rating',
    'new_maintainability_rating',
  ],
  security: ['vulnerabilities', 'new_vulnerabilities', 'security_rating', 'new_security_rating'],
  'dependency-risks': DEPENDENCY_RISK_METRICS,
};

/** Reverse lookup derived from `CATEGORY_METRICS`, for O(1) access by metric key. */
export const METRIC_CATEGORIES: ReadonlyMap<string, string> = new Map(
  Object.entries(CATEGORY_METRICS).flatMap(([category, metrics]) =>
    metrics.map((metric) => [metric, category] as const),
  ),
);

export const IMPLEMENTED_CATEGORIES = Object.keys(CATEGORY_METRICS);

export interface AttachBreakdownsParams {
  client: SonarHttpClient;
  projectKey: string;
  orgKey?: string;
  metrics: Metric[];
  category?: string;
  top: number;
  branch?: string;
  pullRequest?: string;
  componentKey?: string;
}

/** True when failing and in an implemented category, filtered to `category` if given. */
function isFailingMetricInCategory(
  metricKey: string,
  status: string,
  category: string | undefined,
): boolean {
  const conditionCategory = METRIC_CATEGORIES.get(metricKey);
  return status !== 'OK' && !!conditionCategory && (!category || category === conditionCategory);
}

/** True when a failing condition falls into `category` - kept distinct from an empty breakdown result, which shouldn't warn. */
export function hasFailingConditionInCategory(
  conditions: QualityGateCondition[],
  category: string,
): boolean {
  return conditions.some((condition) =>
    isFailingMetricInCategory(condition.metricKey, condition.status, category),
  );
}

/** The condition's category when enrichable, or undefined when there's nothing to build. */
function resolveEnrichableCategory(
  condition: QualityGateConditionSummary,
  filterCategory: string | undefined,
): string | undefined {
  if (condition.status === 'OK') {
    return undefined;
  }
  const conditionCategory = METRIC_CATEGORIES.get(condition.metric);
  if (!conditionCategory || (filterCategory && filterCategory !== conditionCategory)) {
    return undefined;
  }
  return conditionCategory;
}

export interface CategoryBreakdownCaches {
  issues: IssuesBreakdownCache;
  security: SecurityBreakdownCache;
}

/**
 * Returns each condition with its own `breakdown` attached when applicable, preserving order and
 * count 1:1 with the input. Worst-first sort direction comes from the condition's own
 * `comparator` (`LT` - lower is worse - sorts ascending, `GT` sorts descending).
 */
export async function attachBreakdowns(
  conditions: QualityGateConditionSummary[],
  params: AttachBreakdownsParams,
): Promise<QualityGateConditionSummary[]> {
  const measuresClient = new MeasuresClient(params.client);
  const issuesClient = new IssuesClient(params.client);
  const caches: CategoryBreakdownCaches = { issues: new Map(), security: new Map() };
  const metricsByKey = new Map(params.metrics.map((metric) => [metric.key, metric]));

  return Promise.all(
    conditions.map(async (condition) => {
      const category = resolveEnrichableCategory(condition, params.category);
      if (!category) {
        return condition;
      }
      const breakdown = await fetchCategoryBreakdown(
        category,
        measuresClient,
        issuesClient,
        caches,
        params,
        condition,
        metricsByKey.get(condition.metric),
      );
      return breakdown ? { ...condition, breakdown } : condition;
    }),
  );
}

export function fetchCategoryBreakdown(
  category: string,
  measuresClient: MeasuresClient,
  issuesClient: IssuesClient,
  caches: CategoryBreakdownCaches,
  params: AttachBreakdownsParams,
  condition: QualityGateConditionSummary,
  metric: Metric | undefined,
): Promise<QualityGateMetricBreakdown | undefined> {
  switch (category) {
    case 'coverage':
      return fetchMetricBreakdown(measuresClient, params, condition, metric);
    case 'duplications':
      return fetchDuplicationsBreakdown(measuresClient, params, condition, metric);
    case 'issues':
      return fetchIssuesBreakdown(issuesClient, params, condition, caches.issues);
    case 'security':
      return fetchSecurityBreakdown(issuesClient, params, condition, caches.security);
    case 'dependency-risks':
      return fetchDependencyRisksBreakdown(params, condition);
    default:
      return Promise.resolve(undefined);
  }
}

export async function fetchMetricBreakdown(
  measuresClient: MeasuresClient,
  params: AttachBreakdownsParams,
  condition: QualityGateConditionSummary,
  metric: Metric | undefined,
): Promise<QualityGateMetricBreakdown | undefined> {
  try {
    const { entries, totalCount, fetchedCount } = await fetchWorstFileEntries(
      measuresClient,
      params,
      condition,
      metric,
    );
    if (entries.length === 0) {
      return undefined;
    }
    return { category: 'coverage', totalCount, fetchedCount, entries };
  } catch (err) {
    logger.debug(`Failed to build quality gate breakdown for '${condition.metric}'`, err);
    return undefined;
  }
}
