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
import { IssuesClient } from '@/core/server/issues.ts';
import { extractMeasureValue, MeasuresClient } from '@/core/server/measures.ts';
import type { ComponentTreeMeasure, Metric, QualityGateCondition } from '@/core/server/types.ts';

import type { AttachBreakdownsParams, CategoryBreakdownCaches } from './breakdown.ts';
import {
  fetchCategoryBreakdown,
  METRIC_CATEGORIES,
  resolveEnrichableCategory,
} from './breakdown.ts';
import {
  formatOptionalValue,
  type QualityGateConditionSummary,
  type QualityGateMetricBreakdown,
} from './condition-summary.ts';

export interface FetchFileScopedConditionsParams {
  client: SonarHttpClient;
  projectKey: string;
  componentKey: string;
  orgKey?: string;
  metrics: Metric[];
  category?: string;
  top: number;
  branch?: string;
  pullRequest?: string;
}

interface FileScopeContext {
  measuresClient: MeasuresClient;
  issuesClient: IssuesClient;
  caches: CategoryBreakdownCaches;
  isDirectory: boolean;
}

const DIRECTORY_ONLY_CATEGORIES = new Set(['coverage', 'duplications']);

const FILE_SCOPED_CATEGORIES = new Set(['coverage', 'duplications', 'issues', 'security']);

const COMPARATOR_FAILS: Partial<Record<string, (actual: number, threshold: number) => boolean>> = {
  LT: (actual, threshold) => actual < threshold,
  GT: (actual, threshold) => actual > threshold,
  EQ: (actual, threshold) => actual === threshold,
  NE: (actual, threshold) => actual !== threshold,
};

export async function fetchFileScopedConditions(
  rawConditions: QualityGateCondition[],
  params: FetchFileScopedConditionsParams,
): Promise<QualityGateConditionSummary[]> {
  const applicable = rawConditions.filter((condition) => {
    const category = METRIC_CATEGORIES.get(condition.metricKey);
    return !!category && FILE_SCOPED_CATEGORIES.has(category);
  });
  if (applicable.length === 0) {
    return [];
  }

  const measuresClient = new MeasuresClient(params.client);
  const issuesClient = new IssuesClient(params.client);
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
  const context: FileScopeContext = {
    measuresClient,
    issuesClient,
    caches: { issues: new Map(), security: new Map() },
    isDirectory,
  };

  return Promise.all(
    applicable.map((condition) =>
      buildFileConditionSummary(
        condition,
        component.measures,
        metricsByKey.get(condition.metricKey),
        context,
        params,
      ),
    ),
  );
}

async function buildFileConditionSummary(
  condition: QualityGateCondition,
  measures: ComponentTreeMeasure[],
  metric: Metric | undefined,
  context: FileScopeContext,
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

  const category = resolveEnrichableCategory(summary, params.category);
  if (!category) {
    return summary;
  }

  const breakdownParams: AttachBreakdownsParams = {
    client: params.client,
    projectKey: params.projectKey,
    componentKey: params.componentKey,
    orgKey: params.orgKey,
    metrics: params.metrics,
    top: params.top,
    branch: params.branch,
    pullRequest: params.pullRequest,
  };
  const breakdown = await fetchBreakdownForCategory(
    category,
    context,
    breakdownParams,
    summary,
    metric,
  );

  return breakdown ? { ...summary, breakdown } : summary;
}

function fetchBreakdownForCategory(
  category: string,
  context: FileScopeContext,
  params: AttachBreakdownsParams,
  condition: QualityGateConditionSummary,
  metric: Metric | undefined,
): Promise<QualityGateMetricBreakdown | undefined> {
  if (DIRECTORY_ONLY_CATEGORIES.has(category) && !context.isDirectory) {
    return Promise.resolve(undefined);
  }
  return fetchCategoryBreakdown(
    category,
    context.measuresClient,
    context.issuesClient,
    context.caches,
    params,
    condition,
    metric,
  );
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
