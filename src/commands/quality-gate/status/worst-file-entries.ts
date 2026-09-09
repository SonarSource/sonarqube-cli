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

// Fetches the worst-N files for a metric and builds their base breakdown entries

import type { MeasuresClient } from '@/core/server/measures.ts';
import { isNewCodeMetric } from '@/core/server/measures.ts';
import type { ComponentTreeComponent, Metric } from '@/core/server/types.ts';

import type { AttachBreakdownsParams } from './breakdown.ts';
import type {
  QualityGateBreakdownEntry,
  QualityGateConditionSummary,
} from './condition-summary.ts';
import { formatMetricValue } from './format-metric-value.ts';

export interface WorstFileEntriesResult {
  components: ComponentTreeComponent[];
  entries: QualityGateBreakdownEntry[];
  totalCount: number;
  fetchedCount: number;
}

/**
 * A value sitting at the metric's floor/ceiling (0% duplication, 100% coverage) has nothing left
 * to contribute, so files there are excluded from the breakdown.
 */
const NON_CONTRIBUTING_BOUNDARY: Partial<Record<string, number>> = { LT: 100, GT: 0 };

type BreakdownEntryOutcome =
  | { kind: 'entry'; entry: QualityGateBreakdownEntry }
  | { kind: 'missing-value' }
  | { kind: 'non-contributing' };

export async function fetchWorstFileEntries(
  measuresClient: MeasuresClient,
  params: AttachBreakdownsParams,
  condition: QualityGateConditionSummary,
  metric: Metric | undefined,
): Promise<WorstFileEntriesResult> {
  const { components, totalCount } = await measuresClient
    .getWorstComponentsByMetric({
      projectKey: params.projectKey,
      metricKey: condition.metric,
      ascending: condition.comparator === 'LT',
      top: params.top,
      branch: params.branch,
      pullRequest: params.pullRequest,
    })
    .orThrow();

  const outcomes = components.map((component) =>
    toBreakdownEntryOutcome(component, condition, metric),
  );
  const entries = outcomes.flatMap((outcome) => (outcome.kind === 'entry' ? [outcome.entry] : []));

  const exhausted = outcomes.some((outcome) => outcome.kind === 'non-contributing');
  if (exhausted) {
    return { components, entries, totalCount: entries.length, fetchedCount: entries.length };
  }
  return { components, entries, totalCount, fetchedCount: components.length };
}

function toBreakdownEntryOutcome(
  component: ComponentTreeComponent,
  condition: QualityGateConditionSummary,
  metric: Metric | undefined,
): BreakdownEntryOutcome {
  if (!component.path) {
    return { kind: 'missing-value' };
  }
  const measure = component.measures.find((m) => m.metric === condition.metric);
  const rawValue = isNewCodeMetric(condition.metric)
    ? measure?.periods?.[0]?.value
    : (measure?.value ?? measure?.periods?.[0]?.value);
  if (rawValue === undefined) {
    return { kind: 'missing-value' };
  }
  if (!isContributing(condition.comparator, rawValue)) {
    return { kind: 'non-contributing' };
  }
  return {
    kind: 'entry',
    entry: {
      path: component.path,
      value: rawValue,
      formattedValue: metric
        ? formatMetricValue(metric.type, rawValue, metric.decimalScale)
        : rawValue,
    },
  };
}

function isContributing(comparator: string, rawValue: string): boolean {
  const boundary = NON_CONTRIBUTING_BOUNDARY[comparator];
  if (boundary === undefined) {
    return true;
  }
  return comparator === 'LT' ? Number(rawValue) < boundary : Number(rawValue) > boundary;
}
