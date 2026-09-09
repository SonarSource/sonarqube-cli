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

// Builds the security-category breakdown (Security domain only - hotspots are out of scope)

import type { IssuesClient } from '@/core/server/issues.ts';
import { isNewCodeMetric } from '@/core/server/measures.ts';

import type { AttachBreakdownsParams } from './breakdown.ts';
import type {
  QualityGateConditionSummary,
  QualityGateMetricBreakdown,
} from './condition-summary.ts';
import { searchIssuesBreakdown } from './issues-enrichment.ts';

/**
 * `vulnerabilities`/`security_rating` (overall) and `new_vulnerabilities`/`new_security_rating`
 * resolve to byte-identical search params - a gate failing both members of a pair would
 * otherwise fire the same `/api/issues/search` request twice. Keyed by `sinceLeakPeriod`, the
 * only param that varies here, and shared across the whole call by `attachBreakdowns`.
 */
export type SecurityBreakdownCache = Map<string, Promise<QualityGateMetricBreakdown | undefined>>;

export function fetchSecurityBreakdown(
  issuesClient: IssuesClient,
  params: AttachBreakdownsParams,
  condition: QualityGateConditionSummary,
  cache: SecurityBreakdownCache,
): Promise<QualityGateMetricBreakdown | undefined> {
  const sinceLeakPeriod = isNewCodeMetric(condition.metric);
  const cacheKey = String(sinceLeakPeriod);

  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const promise = searchIssuesBreakdown(
    issuesClient,
    params,
    condition,
    'VULNERABILITY',
    sinceLeakPeriod,
  );
  cache.set(cacheKey, promise);
  return promise;
}
