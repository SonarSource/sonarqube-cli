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

import type {
  StatsSinceChoice,
  StatsStoppedBreakdown,
  StatsStopPoint,
  StatsSummary,
} from '@/core/stats/stats-queries.ts';

import type { StatsEntitlement } from '../entitlement.ts';
import {
  type PopulatedStatsViewModel,
  type StatsCardViewModel,
  type StatsMetricRow,
  type StatsUnavailable,
  UNIDENTIFIED_AGENT_LABEL,
} from './index.ts';

const MAX_SPARKLINE_COLUMNS = 30;
const PERCENT_MULTIPLIER = 100;
const SINCE_WINDOW_DAYS = { '7d': 7, '14d': 14, '30d': 30 } as const;
const STOP_POINT_ORDER: readonly StatsStopPoint[] = ['commit', 'prompt', 'file-read', 'push'];

function percentOf(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * PERCENT_MULTIPLIER) : 0;
}
function downsampleSum(values: number[], bucketDays: number): number[] {
  if (bucketDays <= 1) return values;
  const buckets: number[] = [];
  for (let i = 0; i < values.length; i += bucketDays) {
    buckets.push(values.slice(i, i + bucketDays).reduce((sum, value) => sum + value, 0));
  }
  return buckets;
}
function buildCard(
  summary: StatsSummary,
  since: StatsSinceChoice,
  entitlement: StatsEntitlement,
): StatsCardViewModel {
  const bucketDays = Math.max(1, Math.ceil(summary.daily.length / MAX_SPARKLINE_COLUMNS));
  const metrics: StatsMetricRow[] = [
    {
      metric: 'runs',
      windowValue: summary.totalRuns,
      allTimeValue: summary.allTime.totalRuns,
      series: summary.daily.map((d) => d.runs),
    },
    {
      metric: 'findings',
      windowValue: summary.totalFindings,
      allTimeValue: summary.allTime.totalFindings,
      series: summary.daily.map((d) => d.findings),
    },
    {
      metric: 'secrets-blocked',
      windowValue:
        since === 'all'
          ? summary.allTime.secretsBlockedTotal
          : summary.stopped.reduce((sum, entry) => sum + entry.count, 0),
      allTimeValue: summary.allTime.secretsBlockedTotal,
      series: summary.dailySecretsBlocked.map((d) => d.count),
    },
  ];
  if (entitlement.sca !== 'not_enabled') {
    metrics.push({
      metric: 'dependency-risks',
      windowValue: summary.analyzers.find((a) => a.analyzer === 'sca-scanner-cli')?.findings ?? 0,
      allTimeValue: summary.allTime.dependencyRisksTotal,
      series: summary.dailyDependencyRisks.map((d) => d.count),
    });
  }
  for (const metric of metrics) metric.series = downsampleSum(metric.series, bucketDays);
  const unavailable: StatsUnavailable[] = [];
  if (entitlement.vortex === 'not_entitled') unavailable.push('vortex-analysis');
  if (entitlement.sca === 'not_enabled') unavailable.push('dependency-risks');
  return {
    startedAtMs: summary.firstSeenMs ?? Date.now(),
    bucketDays,
    columnCount: Math.ceil(summary.daily.length / bucketDays),
    metrics,
    unavailable,
  };
}
function buildStopped(summary: StatsSummary): PopulatedStatsViewModel['stopped'] {
  if (summary.stopped.length === 0) return null;
  const byPoint = new Map(summary.stopped.map((entry) => [entry.point, entry]));
  const entries = STOP_POINT_ORDER.map((point) => byPoint.get(point)).filter(
    (entry): entry is StatsStoppedBreakdown => entry !== undefined,
  );
  return {
    total: entries.reduce((sum, entry) => sum + entry.count, 0),
    entries,
    topSecretTypes: summary.topSecretTypes,
  };
}
function buildAgents(summary: StatsSummary): PopulatedStatsViewModel['agents'] {
  if (summary.agentBreakdown.length === 0) return null;
  const total = summary.agentBreakdown.reduce((sum, row) => sum + row.findings, 0);
  return {
    total,
    rows: summary.agentBreakdown.map(({ agent, findings }) => ({
      agent,
      findings,
      sharePercent: percentOf(findings, total),
    })),
    hitPercent: summary.agentHitRate
      ? percentOf(summary.agentHitRate.runsWithFindings, summary.agentHitRate.totalRuns)
      : null,
    hasUnidentified: summary.agentBreakdown.some((row) => row.agent === UNIDENTIFIED_AGENT_LABEL),
  };
}
function buildTriggers(summary: StatsSummary): PopulatedStatsViewModel['triggers'] {
  const hooks = summary.triggers.find((t) => t.trigger === 'hooks')?.runs ?? 0;
  const manual = summary.triggers.find((t) => t.trigger === 'manual')?.runs ?? 0;
  const total = hooks + manual;
  return total === 0
    ? null
    : { hooksPercent: percentOf(hooks, total), manualPercent: percentOf(manual, total) };
}
export function buildStatsViewModel(
  summary: StatsSummary,
  since: StatsSinceChoice,
  entitlement: StatsEntitlement,
): PopulatedStatsViewModel {
  return {
    hasHistory: true,
    window: since === 'all' ? { since } : { since, days: SINCE_WINDOW_DAYS[since] },
    entitlement,
    card: buildCard(summary, since, entitlement),
    analyzers:
      summary.analyzers.length === 0
        ? null
        : {
            total: summary.analyzers.reduce((sum, row) => sum + row.runs, 0),
            rows: [...summary.analyzers]
              .sort((a, b) => b.runs - a.runs)
              .map(({ analyzer, runs }) => ({ analyzer, runs })),
          },
    stopped: buildStopped(summary),
    agents: buildAgents(summary),
    callerCommands:
      summary.callerCommandBreakdown.length === 0
        ? null
        : {
            total: summary.callerCommandBreakdown.reduce((sum, row) => sum + row.runs, 0),
            rows: summary.callerCommandBreakdown,
          },
    topRules: summary.topRules.length === 0 ? null : summary.topRules,
    triggers: buildTriggers(summary),
  };
}
