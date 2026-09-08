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
import { isNewCodeMetric, MeasuresClient } from '@/core/server/measures.ts';
import type { ComponentTreeComponent, Metric, QualityGateCondition } from '@/core/server/types.ts';

import type {
  QualityGateBreakdownEntry,
  QualityGateConditionSummary,
  QualityGateMetricBreakdown,
} from './condition-summary.ts';
import { formatMetricValue } from './format-metric-value.ts';

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
};

/** Reverse lookup derived from `CATEGORY_METRICS`, for O(1) access by metric key. */
const METRIC_CATEGORIES: ReadonlyMap<string, string> = new Map(
  Object.entries(CATEGORY_METRICS).flatMap(([category, metrics]) =>
    metrics.map((metric) => [metric, category] as const),
  ),
);

export const IMPLEMENTED_CATEGORIES = Object.keys(CATEGORY_METRICS);

export interface AttachBreakdownsParams {
  client: SonarHttpClient;
  projectKey: string;
  metrics: Metric[];
  category?: string;
  top: number;
  branch?: string;
  pullRequest?: string;
}

/**
 * True when a failing condition's metric falls into an implemented category, filtered to
 * `category` when given.
 */
function isFailingMetricInCategory(
  metricKey: string,
  status: string,
  category: string | undefined,
): boolean {
  const conditionCategory = METRIC_CATEGORIES.get(metricKey);
  return status !== 'OK' && !!conditionCategory && (!category || category === conditionCategory);
}

/**
 * True when at least one failing condition falls into `category` - distinct from the resulting
 * breakdown being empty for another reason (a matching condition's enrichment fetch failing, or
 * returning no files), which should stay silent rather than warn.
 */
export function hasFailingConditionInCategory(
  conditions: QualityGateCondition[],
  category: string,
): boolean {
  return conditions.some((condition) =>
    isFailingMetricInCategory(condition.metricKey, condition.status, category),
  );
}

/** A failing condition whose metric falls into an implemented category, when given. */
function isEnrichableCondition(
  condition: QualityGateConditionSummary,
  category: string | undefined,
): boolean {
  return isFailingMetricInCategory(condition.metric, condition.status, category);
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
  const metricsByKey = new Map(params.metrics.map((metric) => [metric.key, metric]));

  return Promise.all(
    conditions.map(async (condition) => {
      if (!isEnrichableCondition(condition, params.category)) {
        return condition;
      }
      const breakdown = await fetchMetricBreakdown(measuresClient, params, condition, metricsByKey);
      return breakdown ? { ...condition, breakdown } : condition;
    }),
  );
}

function fetchMetricBreakdown(
  measuresClient: MeasuresClient,
  params: AttachBreakdownsParams,
  condition: QualityGateConditionSummary,
  metricsByKey: Map<string, Metric>,
): Promise<QualityGateMetricBreakdown | undefined> {
  return measuresClient
    .getWorstComponentsByMetric({
      projectKey: params.projectKey,
      metricKey: condition.metric,
      ascending: condition.comparator === 'LT',
      top: params.top,
      branch: params.branch,
      pullRequest: params.pullRequest,
    })
    .match(
      ({ components, totalCount }) => {
        const entries = components.flatMap((component) =>
          toBreakdownEntry(component, condition.metric, metricsByKey.get(condition.metric)),
        );
        return entries.length > 0
          ? { totalCount, fetchedCount: components.length, entries }
          : undefined;
      },
      (err) => {
        logger.debug(`Failed to build quality gate breakdown for '${condition.metric}'`, err);
        return undefined;
      },
    );
}

function toBreakdownEntry(
  component: ComponentTreeComponent,
  metricKey: string,
  metric: Metric | undefined,
): QualityGateBreakdownEntry[] {
  if (!component.path) {
    return [];
  }
  const measure = component.measures.find((m) => m.metric === metricKey);
  const rawValue = isNewCodeMetric(metricKey)
    ? measure?.periods?.[0]?.value
    : (measure?.value ?? measure?.periods?.[0]?.value);
  if (rawValue === undefined) {
    return [];
  }
  return [
    {
      path: component.path,
      value: rawValue,
      formattedValue: metric
        ? formatMetricValue(metric.type, rawValue, metric.decimalScale)
        : rawValue,
    },
  ];
}
