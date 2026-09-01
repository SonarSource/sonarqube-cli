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
import type { SonarQubeClient } from '@/core/server/client.ts';
import { isNewCodeMetric, MeasuresClient } from '@/core/server/measures.ts';
import type { ComponentTreeComponent, Metric, QualityGateCondition } from '@/core/server/types.ts';

import { formatMetricValue } from './format-metric-value.ts';

const METRIC_CATEGORIES: Record<string, string> = {
  coverage: 'coverage',
  branch_coverage: 'coverage',
  line_coverage: 'coverage',
  new_coverage: 'coverage',
  new_branch_coverage: 'coverage',
  new_line_coverage: 'coverage',
};

export interface QualityGateBreakdownEntry {
  path: string;
  value: string;
  formattedValue: string;
}

export interface QualityGateMetricBreakdown {
  metric: string;
  totalCount: number;
  fetchedCount: number;
  entries: QualityGateBreakdownEntry[];
}

export interface BuildBreakdownParams {
  client: SonarQubeClient;
  projectKey: string;
  conditions: QualityGateCondition[];
  metrics: Metric[];
  top: number;
  branch?: string;
  pullRequest?: string;
}

/** A failing condition whose metric falls into an implemented category. */
function isEnrichableCondition(condition: QualityGateCondition): boolean {
  return condition.status !== 'OK' && !!METRIC_CATEGORIES[condition.metricKey];
}

/**
 * One breakdown per matching condition. Worst-first sort direction comes from the condition's own
 * `comparator` (`LT` - lower is worse - sorts ascending, `GT` sorts descending).
 */
export async function buildBreakdown(
  params: BuildBreakdownParams,
): Promise<QualityGateMetricBreakdown[]> {
  const measuresClient = new MeasuresClient(params.client);
  const metricsByKey = new Map(params.metrics.map((metric) => [metric.key, metric]));

  const results = await Promise.all(
    params.conditions
      .filter(isEnrichableCondition)
      .map((condition) => fetchMetricBreakdown(measuresClient, params, condition, metricsByKey)),
  );
  return results.filter((result): result is QualityGateMetricBreakdown => result !== undefined);
}

async function fetchMetricBreakdown(
  measuresClient: MeasuresClient,
  params: BuildBreakdownParams,
  condition: QualityGateCondition,
  metricsByKey: Map<string, Metric>,
): Promise<QualityGateMetricBreakdown | undefined> {
  try {
    const { components, totalCount } = await measuresClient.getWorstComponentsByMetric({
      projectKey: params.projectKey,
      metricKey: condition.metricKey,
      ascending: condition.comparator === 'LT',
      top: params.top,
      branch: params.branch,
      pullRequest: params.pullRequest,
    });

    const entries = components.flatMap((component) =>
      toBreakdownEntry(component, condition.metricKey, metricsByKey.get(condition.metricKey)),
    );
    return entries.length > 0
      ? { metric: condition.metricKey, totalCount, fetchedCount: components.length, entries }
      : undefined;
  } catch (err) {
    logger.debug(`Failed to build quality gate breakdown for '${condition.metricKey}'`, err);
    return undefined;
  }
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
