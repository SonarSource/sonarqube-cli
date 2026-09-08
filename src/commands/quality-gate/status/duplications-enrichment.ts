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

// Builds the duplications-category breakdown

import { runWithConcurrencyLimit } from '@/core/concurrency/concurrency-pool.ts';
import logger from '@/core/observability/logger.ts';
import { unwrapOrThrow } from '@/core/result.ts';
import { DuplicationsClient } from '@/core/server/duplications.ts';
import type { SonarHttpClient } from '@/core/server/http-client.ts';
import type { MeasuresClient } from '@/core/server/measures.ts';
import type { ComponentTreeComponent, Metric } from '@/core/server/types.ts';

import type { AttachBreakdownsParams } from './breakdown.ts';
import type {
  DuplicationsBreakdownEntry,
  QualityGateConditionSummary,
  QualityGateMetricBreakdown,
} from './condition-summary.ts';
import { fetchWorstFileEntries } from './worst-file-entries.ts';

export interface DuplicationsEnrichmentParams {
  client: SonarHttpClient;
  branch?: string;
  pullRequest?: string;
}

/** Keeps per-file enrichment from fanning out to `--top` (up to 500) parallel requests. */
const DUPLICATIONS_FETCH_CONCURRENCY = 8;

export async function fetchDuplicationsBreakdown(
  measuresClient: MeasuresClient,
  params: AttachBreakdownsParams,
  condition: QualityGateConditionSummary,
  metric: Metric | undefined,
): Promise<QualityGateMetricBreakdown | undefined> {
  try {
    const { components, entries, totalCount, fetchedCount } = await fetchWorstFileEntries(
      measuresClient,
      params,
      condition,
      metric,
    );
    await enrichDuplicationsEntries(entries, components, params);
    if (entries.length === 0) {
      return undefined;
    }
    return { category: 'duplications', totalCount, fetchedCount, entries };
  } catch (err) {
    logger.debug(`Failed to build quality gate breakdown for '${condition.metric}'`, err);
    return undefined;
  }
}

/**
 * Matched back to entries by path. Degrades per file on failure.
 */
export async function enrichDuplicationsEntries(
  entries: DuplicationsBreakdownEntry[],
  components: ComponentTreeComponent[],
  params: DuplicationsEnrichmentParams,
): Promise<void> {
  const duplicationsClient = new DuplicationsClient(params.client);
  const componentsByPath = new Map(components.map((component) => [component.path, component]));

  const results = await runWithConcurrencyLimit(
    entries,
    DUPLICATIONS_FETCH_CONCURRENCY,
    async (entry) => {
      const componentKey = componentsByPath.get(entry.path)?.key;
      if (!componentKey) {
        return;
      }
      const info = await unwrapOrThrow(
        duplicationsClient.getDuplicationInfo({
          componentKey,
          branch: params.branch,
          pullRequest: params.pullRequest,
        }),
      );
      entry.blockCount = info.blockCount;
      entry.duplicatesWith = info.duplicatesWith;
    },
  );

  const failedCount = results.filter((result) => result.status === 'rejected').length;
  if (failedCount > 0) {
    logger.debug(`Failed to fetch duplication info for ${failedCount}/${entries.length} files`);
  }
}
