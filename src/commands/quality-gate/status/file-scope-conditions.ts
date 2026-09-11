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

import type { SonarHttpClient } from '@/core/server/http-client.ts';
import { extractMeasureValue, MeasuresClient } from '@/core/server/measures.ts';
import type { ComponentTreeMeasure, Metric, QualityGateCondition } from '@/core/server/types.ts';

import { fetchMetricBreakdown, METRIC_CATEGORIES } from './breakdown.ts';
import { formatOptionalValue, type QualityGateConditionSummary } from './condition-summary.ts';
import { fetchDuplicationsBreakdown } from './duplications-enrichment.ts';

export interface FetchFileScopedConditionsParams {
  client: SonarHttpClient;
  projectKey: string;
  componentKey: string;
  metrics: Metric[];
  top: number;
  branch?: string;
  pullRequest?: string;
}

const COMPARATOR_FAILS: Partial<Record<string, (actual: number, threshold: number) => boolean>> = {
  LT: (actual, threshold) => actual < threshold,
  GT: (actual, threshold) => actual > threshold,
  EQ: (actual, threshold) => actual === threshold,
  NE: (actual, threshold) => actual !== threshold,
};

/**
 * Coverage/duplications conditions for a single resolved file or directory, evaluated against
 * that component's own value rather than the project's.
 */
export async function fetchFileScopedConditions(
  rawConditions: QualityGateCondition[],
  params: FetchFileScopedConditionsParams,
): Promise<QualityGateConditionSummary[]> {
  const applicable = rawConditions.filter((condition) => {
    const category = METRIC_CATEGORIES.get(condition.metricKey);
    return category === 'coverage' || category === 'duplications';
  });
  if (applicable.length === 0) {
    return [];
  }

  const measuresClient = new MeasuresClient(params.client);
  const component = await measuresClient
    .getComponentMeasures({
      componentKey: params.componentKey,
      metricKeys: applicable.map((condition) => condition.metricKey),
      branch: params.branch,
      pullRequest: params.pullRequest,
    })
    .orThrow();
  const isDirectory = component.qualifier === 'DIR';

  const metricsByKey = new Map(params.metrics.map((metric) => [metric.key, metric]));

  return Promise.all(
    applicable.map((condition) =>
      buildFileConditionSummary(
        condition,
        component.measures,
        metricsByKey.get(condition.metricKey),
        isDirectory,
        measuresClient,
        params,
      ),
    ),
  );
}

async function buildFileConditionSummary(
  condition: QualityGateCondition,
  measures: ComponentTreeMeasure[],
  metric: Metric | undefined,
  isDirectory: boolean,
  measuresClient: MeasuresClient,
  params: FetchFileScopedConditionsParams,
): Promise<QualityGateConditionSummary> {
  const rawValue = extractMeasureValue(measures, condition.metricKey);
  const status = resolveConditionStatus(condition, rawValue);

  const summary: QualityGateConditionSummary = {
    metric: condition.metricKey,
    metricName: metric?.name ?? condition.metricKey,
    metricType: metric?.type,
    status,
    comparator: condition.comparator,
    threshold: condition.errorThreshold,
    formattedThreshold: formatOptionalValue(condition.errorThreshold, metric),
    actualValue: rawValue,
    formattedActualValue: formatOptionalValue(rawValue, metric),
  };

  if (!isDirectory || status !== 'ERROR') {
    return summary;
  }

  const breakdownParams = {
    client: params.client,
    projectKey: params.projectKey,
    componentKey: params.componentKey,
    metrics: params.metrics,
    top: params.top,
    branch: params.branch,
    pullRequest: params.pullRequest,
  };
  const category = METRIC_CATEGORIES.get(condition.metricKey);
  const breakdown =
    category === 'coverage'
      ? await fetchMetricBreakdown(measuresClient, breakdownParams, summary, metric)
      : await fetchDuplicationsBreakdown(measuresClient, breakdownParams, summary, metric);

  return breakdown ? { ...summary, breakdown } : summary;
}

function resolveConditionStatus(
  condition: QualityGateCondition,
  rawValue: string | undefined,
): 'OK' | 'ERROR' {
  if (rawValue === undefined || condition.errorThreshold === undefined) {
    return 'OK';
  }
  return isConditionFailing(condition.comparator, rawValue, condition.errorThreshold)
    ? 'ERROR'
    : 'OK';
}

function isConditionFailing(comparator: string, actualValue: string, threshold: string): boolean {
  const evaluate = COMPARATOR_FAILS[comparator];
  return evaluate ? evaluate(Number(actualValue), Number(threshold)) : false;
}
