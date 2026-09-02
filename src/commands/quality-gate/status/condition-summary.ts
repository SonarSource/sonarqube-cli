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

// Normalizes and filters raw quality gate conditions for CLI output, enriched with metric
// metadata (human-readable name, type, and type-aware formatted values) looked up from the
// server's metric catalog.

import type { Metric, QualityGateCondition } from '@/core/server/types.ts';

import { formatMetricValue } from './format-metric-value.ts';

export interface QualityGateBreakdownEntry {
  path: string;
  value: string;
  formattedValue: string;
}

export interface QualityGateMetricBreakdown {
  totalCount: number;
  fetchedCount: number;
  entries: QualityGateBreakdownEntry[];
}

export interface QualityGateConditionSummary {
  metric: string;
  metricName: string;
  metricType?: string;
  status: string;
  comparator: string;
  threshold?: string;
  formattedThreshold?: string;
  actualValue?: string;
  formattedActualValue?: string;
  breakdown?: QualityGateMetricBreakdown;
}

function isFailing(condition: QualityGateConditionSummary): boolean {
  return condition.status !== 'OK';
}

/**
 * `metric` is undefined when a condition's key isn't found in the fetched catalog - shouldn't
 * happen since both come from the same server, but the join degrades gracefully rather than
 * throwing on a lookup miss.
 */
function formatOptionalValue(
  rawValue: string | undefined,
  metric: Metric | undefined,
): string | undefined {
  if (rawValue === undefined || metric === undefined) {
    return rawValue;
  }
  return formatMetricValue(metric.type, rawValue, metric.decimalScale);
}

function toSummary(
  condition: QualityGateCondition,
  metricsByKey: Map<string, Metric>,
): QualityGateConditionSummary {
  const metric = metricsByKey.get(condition.metricKey);
  return {
    metric: condition.metricKey,
    metricName: metric?.name ?? condition.metricKey,
    metricType: metric?.type,
    status: condition.status,
    comparator: condition.comparator,
    threshold: condition.errorThreshold,
    formattedThreshold: formatOptionalValue(condition.errorThreshold, metric),
    actualValue: condition.actualValue,
    formattedActualValue: formatOptionalValue(condition.actualValue, metric),
  };
}

/**
 * Normalizes raw conditions and orders failing ones first, so a truncated table view
 * always shows the conditions that matter most even before any filtering is applied.
 */
export function selectConditions(
  conditions: QualityGateCondition[] = [],
  metrics: Metric[] = [],
  includeAll = false,
): QualityGateConditionSummary[] {
  const metricsByKey = new Map(metrics.map((metric) => [metric.key, metric]));
  const summaries = conditions.map((condition) => toSummary(condition, metricsByKey));
  const failing = summaries.filter(isFailing);
  const passing = includeAll ? summaries.filter((condition) => !isFailing(condition)) : [];
  return [...failing, ...passing];
}
