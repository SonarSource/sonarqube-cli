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

// Normalizes and filters raw quality gate conditions for CLI output

import type { QualityGateCondition } from '@/core/server/types.ts';

export interface QualityGateConditionSummary {
  metric: string;
  status: string;
  comparator: string;
  threshold?: string;
  actualValue?: string;
}

function isFailing(condition: QualityGateConditionSummary): boolean {
  return condition.status !== 'OK';
}

function toSummary(condition: QualityGateCondition): QualityGateConditionSummary {
  return {
    metric: condition.metricKey,
    status: condition.status,
    comparator: condition.comparator,
    threshold: condition.errorThreshold,
    actualValue: condition.actualValue,
  };
}

/**
 * Normalizes raw conditions and orders failing ones first, so a truncated table view
 * always shows the conditions that matter most even before any filtering is applied.
 */
export function selectConditions(
  conditions: QualityGateCondition[],
  includeAll: boolean,
): QualityGateConditionSummary[] {
  const summaries = conditions.map(toSummary);
  const selected = includeAll ? summaries : summaries.filter(isFailing);
  return [...selected].sort((a, b) => Number(isFailing(b)) - Number(isFailing(a)));
}
