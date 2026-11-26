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
import { queryStatsSummary, type StatsSummary } from '@/core/stats/stats-queries.ts';
import { isDoNotTrackRequested } from '@/core/telemetry/enabled.ts';

import { resolveStatsEntitlement } from './entitlement.ts';
import { renderTextSummary } from './text-report.ts';
import { buildStatsViewModel } from './view-model/build.ts';
import { EMPTY_STATS_VIEW_MODEL, type StatsViewModel } from './view-model/types.ts';

export const STATS_SINCE_CHOICES = ['7d', '14d', '30d', 'all'] as const;
export type StatsSinceChoice = (typeof STATS_SINCE_CHOICES)[number];

export interface StatsOptions {
  since?: StatsSinceChoice;
  json?: boolean;
}

const DO_NOT_TRACK_DISCLAIMER =
  'DO_NOT_TRACK is set, sonar stats is unaffected: this data never leaves your machine.';

export async function stats(options: StatsOptions, ctx: CommandInvocationContext): Promise<void> {
  const since = options.since ?? '30d';
  const summary = queryStatsSummary(since);
  if (isDoNotTrackRequested()) {
    ctx.console.info(DO_NOT_TRACK_DISCLAIMER, options.json ? 'stderr' : undefined);
  }
  const viewModel = await resolveViewModel(summary, since, ctx);

  if (options.json) {
    ctx.console.print(JSON.stringify(viewModel, null, 2));
    return;
  }

  renderTextSummary(viewModel, ctx.console);
}

async function resolveViewModel(
  summary: StatsSummary,
  since: StatsSinceChoice,
  ctx: CommandInvocationContext,
): Promise<StatsViewModel> {
  if (summary.allTime.totalRuns === 0) {
    return EMPTY_STATS_VIEW_MODEL;
  }
  return buildStatsViewModel(summary, since, await resolveStatsEntitlement(ctx));
}
