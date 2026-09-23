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

import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { queryStatsSummary } from '@/core/stats/stats-queries.ts';

import { resolveStatsEntitlement } from './entitlement.ts';
import { renderTextSummary } from './text-report.ts';

export const STATS_SINCE_CHOICES = ['7d', '14d', '30d', 'all'] as const;
export type StatsSinceChoice = (typeof STATS_SINCE_CHOICES)[number];

export interface StatsOptions {
  since?: StatsSinceChoice;
  json?: boolean;
}

export async function stats(options: StatsOptions, ctx: CommandInvocationContext): Promise<void> {
  const since = options.since ?? '30d';
  const summary = queryStatsSummary(since);

  if (options.json) {
    const entitlement = summary.allTime.totalRuns > 0 ? await resolveStatsEntitlement(ctx) : null;
    ctx.console.print(JSON.stringify({ ...summary, entitlement }, null, 2));
    return;
  }

  await renderTextSummary(summary, since, ctx);
}
