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

import { resolveSinceDays, sumBy } from '@/core/stats/stats-aggregation.ts';
import type {
  StatsAgentHitRate,
  StatsAgentShare,
  StatsAnalyzerTotal,
  StatsSinceChoice,
  StatsStoppedBreakdown,
  StatsStopPoint,
  StatsSummary,
  StatsTriggerShare,
} from '@/core/stats/stats-queries.ts';

import type { StatsEntitlement } from '../entitlement.ts';
import {
  type PopulatedStatsViewModel,
  type StatsAgentRow,
  type StatsAgentsViewModel,
  type StatsAnalyzerRow,
  type StatsAnalyzersViewModel,
  type StatsCallerCommandsViewModel,
  type StatsCardViewModel,
  type StatsMetricRow,
  type StatsStoppedViewModel,
  type StatsTotaledRows,
  type StatsTriggersViewModel,
  type StatsUnavailable,
  type StatsWindow,
  UNIDENTIFIED_AGENT_LABEL,
} from './types.ts';

const MAX_SPARKLINE_COLUMNS = 30;
const PERCENT_MULTIPLIER = 100;
const SCA_ANALYZER = 'sca-scanner-cli';
const HOOKS_TRIGGER = 'hooks';
const MANUAL_TRIGGER = 'manual';
const STOP_POINT_ORDER: readonly StatsStopPoint[] = ['commit', 'prompt', 'file-read', 'push'];

export function buildStatsViewModel(
  summary: StatsSummary,
  since: StatsSinceChoice,
  entitlement: StatsEntitlement,
): PopulatedStatsViewModel {
  return {
    hasHistory: true,
    window: buildWindow(since),
    entitlement,
    card: buildCard(summary, since, entitlement),
    analyzers: buildAnalyzers(summary.analyzers),
    stopped: buildStopped(summary),
    agents: buildAgents(summary),
    callerCommands: buildCallerCommands(summary),
    topRules: nullIfEmpty(summary.topRules),
    triggers: buildTriggers(summary.triggers),
  };
}

function buildWindow(since: StatsSinceChoice): StatsWindow {
  return since === 'all' ? { since } : { since, days: resolveSinceDays(since) };
}

function buildCard(
  summary: StatsSummary,
  since: StatsSinceChoice,
  entitlement: StatsEntitlement,
): StatsCardViewModel {
  const bucketDays = resolveBucketDays(summary.daily.length);
  return {
    startedAtMs: summary.firstSeenMs ?? Date.now(),
    bucketDays,
    metrics: buildMetrics(summary, since, entitlement, bucketDays),
    unavailable: buildUnavailable(entitlement),
  };
}

function buildMetrics(
  summary: StatsSummary,
  since: StatsSinceChoice,
  entitlement: StatsEntitlement,
  bucketDays: number,
): StatsMetricRow[] {
  const bucketed = (values: readonly number[]): number[] => downsampleSum(values, bucketDays);
  const metrics: StatsMetricRow[] = [
    {
      metric: 'runs',
      windowValue: summary.totalRuns,
      allTimeValue: summary.allTime.totalRuns,
      series: bucketed(summary.daily.map((day) => day.runs)),
    },
    {
      metric: 'findings',
      windowValue: summary.totalFindings,
      allTimeValue: summary.allTime.totalFindings,
      series: bucketed(summary.daily.map((day) => day.findings)),
    },
    {
      metric: 'secrets-blocked',
      windowValue: secretsBlockedInWindow(summary, since),
      allTimeValue: summary.allTime.secretsBlockedTotal,
      series: bucketed(summary.dailySecretsBlocked.map((day) => day.count)),
    },
  ];
  if (entitlement.sca !== 'not_enabled') {
    metrics.push({
      metric: 'dependency-risks',
      windowValue: dependencyRisksInWindow(summary),
      allTimeValue: summary.allTime.dependencyRisksTotal,
      series: bucketed(summary.dailyDependencyRisks.map((day) => day.count)),
    });
  }
  return metrics;
}

function buildUnavailable(entitlement: StatsEntitlement): StatsUnavailable[] {
  const unavailable: StatsUnavailable[] = [];
  if (entitlement.vortex === 'not_entitled') {
    unavailable.push('vortex-analysis');
  }
  if (entitlement.sca === 'not_enabled') {
    unavailable.push('dependency-risks');
  }
  return unavailable;
}

function secretsBlockedInWindow(summary: StatsSummary, since: StatsSinceChoice): number {
  return since === 'all' ? summary.allTime.secretsBlockedTotal : sumBy(summary.stopped, countOf);
}

function dependencyRisksInWindow(summary: StatsSummary): number {
  return summary.analyzers.find((row) => row.analyzer === SCA_ANALYZER)?.findings ?? 0;
}

function resolveBucketDays(totalDays: number): number {
  return Math.max(1, Math.ceil(totalDays / MAX_SPARKLINE_COLUMNS));
}

function downsampleSum(values: readonly number[], bucketDays: number): number[] {
  if (bucketDays <= 1) {
    return [...values];
  }
  const buckets: number[] = [];
  for (let start = 0; start < values.length; start += bucketDays) {
    buckets.push(sum(values.slice(start, start + bucketDays)));
  }
  return buckets;
}

function buildAnalyzers(analyzers: readonly StatsAnalyzerTotal[]): StatsAnalyzersViewModel | null {
  const rows = [...analyzers].sort(byRunsDescending).map(toAnalyzerRow);
  return totaledRows(rows, runsOf);
}

function byRunsDescending(a: StatsAnalyzerTotal, b: StatsAnalyzerTotal): number {
  return b.runs - a.runs;
}

function toAnalyzerRow({ analyzer, runs }: StatsAnalyzerTotal): StatsAnalyzerRow {
  return { analyzer, runs };
}

function buildStopped(summary: StatsSummary): StatsStoppedViewModel | null {
  if (summary.stopped.length === 0) {
    return null;
  }
  const entries = orderStoppedEntries(summary.stopped);
  return {
    total: sumBy(entries, countOf),
    entries,
    topSecretTypes: summary.topSecretTypes,
  };
}

function orderStoppedEntries(entries: readonly StatsStoppedBreakdown[]): StatsStoppedBreakdown[] {
  const byPoint = new Map(entries.map((entry) => [entry.point, entry]));
  return STOP_POINT_ORDER.map((point) => byPoint.get(point)).filter(
    (entry): entry is StatsStoppedBreakdown => entry !== undefined,
  );
}

function buildAgents(summary: StatsSummary): StatsAgentsViewModel | null {
  const { agentBreakdown, agentHitRate } = summary;
  if (agentBreakdown.length === 0) {
    return null;
  }
  const total = sumBy(agentBreakdown, findingsOf);
  return {
    total,
    rows: agentBreakdown.map((agent) => toAgentRow(agent, total)),
    hitPercent: hitPercentOf(agentHitRate),
    hasUnidentified: agentBreakdown.some(isUnidentified),
  };
}

function toAgentRow({ agent, findings }: StatsAgentShare, total: number): StatsAgentRow {
  return { agent, findings, sharePercent: percentOf(findings, total) };
}

function hitPercentOf(hitRate: StatsAgentHitRate | null): number | null {
  return hitRate ? percentOf(hitRate.runsWithFindings, hitRate.totalRuns) : null;
}

function isUnidentified(agent: StatsAgentShare): boolean {
  return agent.agent === UNIDENTIFIED_AGENT_LABEL;
}

function buildCallerCommands(summary: StatsSummary): StatsCallerCommandsViewModel | null {
  return totaledRows(summary.callerCommandBreakdown, runsOf);
}

function buildTriggers(triggers: readonly StatsTriggerShare[]): StatsTriggersViewModel | null {
  const hooks = runsForTrigger(triggers, HOOKS_TRIGGER);
  const manual = runsForTrigger(triggers, MANUAL_TRIGGER);
  const total = hooks + manual;
  if (total === 0) {
    return null;
  }
  return { hooksPercent: percentOf(hooks, total), manualPercent: percentOf(manual, total) };
}

function runsForTrigger(triggers: readonly StatsTriggerShare[], trigger: string): number {
  return triggers.find((row) => row.trigger === trigger)?.runs ?? 0;
}

function totaledRows<T>(rows: T[], countFn: (row: T) => number): StatsTotaledRows<T> | null {
  return rows.length === 0 ? null : { total: sumBy(rows, countFn), rows };
}

function nullIfEmpty<T>(rows: T[]): T[] | null {
  return rows.length === 0 ? null : rows;
}

function percentOf(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * PERCENT_MULTIPLIER) : 0;
}

function sum(values: readonly number[]): number {
  return sumBy(values, (value) => value);
}

function countOf(row: { count: number }): number {
  return row.count;
}

function runsOf(row: { runs: number }): number {
  return row.runs;
}

function findingsOf(row: { findings: number }): number {
  return row.findings;
}
