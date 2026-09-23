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

import {
  EXIT_CODE_SECRETS_FOUND,
  SECRETS_STOP_POINT_BY_CALLER_COMMAND,
} from '@/core/config-constants.ts';

import type {
  StatsAgentHitRate,
  StatsAllTimeTotals,
  StatsAnalyzerTotal,
  StatsCallerCommandRuns,
  StatsDailyCount,
  StatsDailyPoint,
  StatsSecretTypeBreakdown,
  StatsSinceChoice,
  StatsStoppedBreakdown,
  StatsStopPoint,
  StatsTriggerShare,
} from './stats-summary-types.ts';

export const DAY_MS = 86_400_000;

export interface RawRow {
  timestamp_ms: number;
  caller_command: string;
  exit_code: number | null;
  caller_agent: string;
  run_trigger: string;
  details: string;
}

export interface ParsedRow {
  timestampMs: number;
  dayEpoch: number;
  callerCommand: string;
  exitCode: number | null;
  callerAgent: string;
  runTrigger: string;
  analyzer: string;
  findingsCount: number;
  ruleCounts: Record<string, number>;
  stopPoint: StatsStopPoint | undefined;
  isSecretsBlocked: boolean;
}

export interface AggregateRow {
  dimension: string;
  key: string;
  runs: number;
  findings: number;
  runs_with_findings: number;
  blocked: number;
  first_seen_ms: number | null;
}

export interface RankedRule {
  ruleKey: string;
  count: number;
}

export interface WindowDependentFields {
  totalRuns: number;
  totalFindings: number;
  analyzers: StatsAnalyzerTotal[];
  callerCommandBreakdown: StatsCallerCommandRuns[];
  triggers: StatsTriggerShare[];
}

const TOP_RULES_LIMIT = 5;
const TOP_RULES_MIN_COUNT = 10;
const TOP_SECRET_TYPES_LIMIT = 2;
const SECRET_TYPE_OTHERS_LABEL = 'others';
const SECRET_TYPE_SUFFIX_PATTERN = / (?:should|must) not be disclosed\.?$/i;

function deriveSecretTypeLabel(message: string | null, ruleKey: string): string {
  if (!message) return ruleKey;
  return message.replace(SECRET_TYPE_SUFFIX_PATTERN, '').trim() || ruleKey;
}

export function parseRow(row: RawRow): ParsedRow {
  const details = JSON.parse(row.details) as {
    analyzer: string;
    findingsCount: number;
    ruleCounts?: Record<string, number>;
  };
  const stopPoint = SECRETS_STOP_POINT_BY_CALLER_COMMAND[row.caller_command] as
    StatsStopPoint | undefined;
  const isSecretsBlocked =
    details.analyzer === 'sonar-secrets' &&
    row.exit_code === EXIT_CODE_SECRETS_FOUND &&
    stopPoint !== undefined;
  return {
    timestampMs: row.timestamp_ms,
    dayEpoch: Math.floor(row.timestamp_ms / DAY_MS),
    callerCommand: row.caller_command,
    exitCode: row.exit_code,
    callerAgent: row.caller_agent,
    runTrigger: row.run_trigger,
    analyzer: details.analyzer,
    findingsCount: details.findingsCount,
    ruleCounts: details.ruleCounts ?? {},
    stopPoint,
    isSecretsBlocked,
  };
}

function fillDailyGaps<T extends { dayEpoch: number }>(
  rows: readonly T[],
  startDayEpoch: number,
  endDayEpoch: number,
  zeroRow: (dayEpoch: number) => T,
): T[] {
  const byDay = new Map(rows.map((row) => [row.dayEpoch, row]));
  const filled: T[] = [];
  for (let day = startDayEpoch; day <= endDayEpoch; day++) {
    filled.push(byDay.get(day) ?? zeroRow(day));
  }
  return filled;
}

function sumBy<T>(items: readonly T[], fn: (item: T) => number): number {
  return items.reduce((sum, item) => sum + fn(item), 0);
}

function groupCounts<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export function getAggregate(
  aggregates: readonly AggregateRow[],
  dimension: string,
  key: string,
): AggregateRow | undefined {
  return aggregates.find((a) => a.dimension === dimension && a.key === key);
}

function splitRuleAggregateKey(key: string): { analyzer: string; ruleKey: string } {
  const separatorIndex = key.indexOf(':');
  return { analyzer: key.slice(0, separatorIndex), ruleKey: key.slice(separatorIndex + 1) };
}

export function buildWindowFields(rows: readonly ParsedRow[]): WindowDependentFields {
  return {
    totalRuns: rows.length,
    totalFindings: sumBy(rows, (r) => r.findingsCount),
    analyzers: [...groupCounts(rows, (r) => r.analyzer)].map(([analyzer, group]) => ({
      analyzer,
      runs: group.length,
      findings: sumBy(group, (r) => r.findingsCount),
    })),
    callerCommandBreakdown: [...groupCounts(rows, (r) => r.callerCommand)]
      .map(([command, group]) => ({ command, runs: group.length }))
      .sort((a, b) => b.runs - a.runs),
    triggers: [...groupCounts(rows, (r) => r.runTrigger)].map(([trigger, group]) => ({
      trigger,
      runs: group.length,
    })),
  };
}

export function buildAllTimeFields(
  aggregates: readonly AggregateRow[],
  allTime: StatsAllTimeTotals,
): WindowDependentFields {
  return {
    totalRuns: allTime.totalRuns,
    totalFindings: allTime.totalFindings,
    analyzers: aggregates
      .filter((a) => a.dimension === 'analyzer')
      .map((a) => ({ analyzer: a.key, runs: a.runs, findings: a.findings })),
    callerCommandBreakdown: aggregates
      .filter((a) => a.dimension === 'caller_command')
      .map((a) => ({ command: a.key, runs: a.runs }))
      .sort((a, b) => b.runs - a.runs),
    triggers: aggregates
      .filter((a) => a.dimension === 'trigger')
      .map((a) => ({ trigger: a.key, runs: a.runs })),
  };
}

export function windowStopped(rows: readonly ParsedRow[]): StatsStoppedBreakdown[] {
  const blocked = rows.filter((r) => r.isSecretsBlocked && r.stopPoint);
  return [...groupCounts(blocked, (r) => r.stopPoint as string)].map(([point, group]) => ({
    point: point as StatsStopPoint,
    count: group.length,
  }));
}

export function windowAgentHitRate(rows: readonly ParsedRow[]): StatsAgentHitRate | null {
  if (rows.length === 0) return null;
  const runsWithFindings = rows.filter((r) => r.findingsCount > 0).length;
  return { runsWithFindings, totalRuns: rows.length };
}

export function allTimeAgentHitRate(globalAgg: AggregateRow | undefined): StatsAgentHitRate | null {
  if (!globalAgg || globalAgg.runs === 0) return null;
  return { runsWithFindings: globalAgg.runs_with_findings, totalRuns: globalAgg.runs };
}

/** Per-rule occurrence counts across every analyzer, ranking input for {@link rankTopRules}. */
export function windowRuleCounts(rows: readonly ParsedRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const [ruleKey, count] of Object.entries(row.ruleCounts)) {
      counts.set(ruleKey, (counts.get(ruleKey) ?? 0) + count);
    }
  }
  return counts;
}

export function allTimeRuleCounts(aggregates: readonly AggregateRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of aggregates) {
    if (a.dimension !== 'rule') continue;
    const { ruleKey } = splitRuleAggregateKey(a.key);
    counts.set(ruleKey, (counts.get(ruleKey) ?? 0) + a.findings);
  }
  return counts;
}

/** Ranks pre-counted rules, independent of whether the counts came from a window or all-time. */
export function rankTopRules(counts: ReadonlyMap<string, number>): RankedRule[] {
  return [...counts.entries()]
    .filter(([, count]) => count >= TOP_RULES_MIN_COUNT)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_RULES_LIMIT)
    .map(([ruleKey, count]) => ({ ruleKey, count }));
}

export function attachRuleMessages(
  ranked: readonly RankedRule[],
  messages: ReadonlyMap<string, string>,
): Array<RankedRule & { message: string | null }> {
  return ranked.map((r) => ({ ...r, message: messages.get(r.ruleKey) ?? null }));
}

/** Per-secrets-rule occurrence counts, ranking input for {@link buildSecretTypeBreakdown}. */
export function windowSecretRuleCounts(rows: readonly ParsedRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.analyzer !== 'sonar-secrets') continue;
    for (const [ruleKey, count] of Object.entries(row.ruleCounts)) {
      counts.set(ruleKey, (counts.get(ruleKey) ?? 0) + count);
    }
  }
  return counts;
}

export function allTimeSecretRuleCounts(aggregates: readonly AggregateRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of aggregates) {
    if (a.dimension !== 'rule') continue;
    const { analyzer, ruleKey } = splitRuleAggregateKey(a.key);
    if (analyzer === 'sonar-secrets') counts.set(ruleKey, a.findings);
  }
  return counts;
}

export function buildSecretTypeBreakdown(
  counts: ReadonlyMap<string, number>,
  messages: ReadonlyMap<string, string>,
): StatsSecretTypeBreakdown[] {
  const countByLabel = new Map<string, number>();
  for (const [ruleKey, count] of counts) {
    const label = deriveSecretTypeLabel(messages.get(ruleKey) ?? null, ruleKey);
    countByLabel.set(label, (countByLabel.get(label) ?? 0) + count);
  }
  const sorted = [...countByLabel.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, TOP_SECRET_TYPES_LIMIT).map(([label, count]) => ({ label, count }));
  const othersCount = sorted
    .slice(TOP_SECRET_TYPES_LIMIT)
    .reduce((sum, [, count]) => sum + count, 0);
  if (othersCount > 0) top.push({ label: SECRET_TYPE_OTHERS_LABEL, count: othersCount });
  return top;
}

export function windowDaily(
  rows: readonly ParsedRow[],
  startDayEpoch: number,
  endDayEpoch: number,
): StatsDailyPoint[] {
  const grouped = [...groupCounts(rows, (r) => String(r.dayEpoch))].map(([, group]) => ({
    dayEpoch: group[0].dayEpoch,
    runs: group.length,
    findings: sumBy(group, (r) => r.findingsCount),
  }));
  return fillDailyGaps(grouped, startDayEpoch, endDayEpoch, (dayEpoch) => ({
    dayEpoch,
    runs: 0,
    findings: 0,
  }));
}

export function windowDailySecretsBlocked(
  rows: readonly ParsedRow[],
  startDayEpoch: number,
  endDayEpoch: number,
): StatsDailyCount[] {
  const blocked = rows.filter((r) => r.isSecretsBlocked);
  const grouped = [...groupCounts(blocked, (r) => String(r.dayEpoch))].map(([, group]) => ({
    dayEpoch: group[0].dayEpoch,
    count: group.length,
  }));
  return fillDailyGaps(grouped, startDayEpoch, endDayEpoch, (dayEpoch) => ({ dayEpoch, count: 0 }));
}

export function windowDailyDependencyRisks(
  rows: readonly ParsedRow[],
  startDayEpoch: number,
  endDayEpoch: number,
): StatsDailyCount[] {
  const sca = rows.filter((r) => r.analyzer === 'sca-scanner-cli');
  const grouped = [...groupCounts(sca, (r) => String(r.dayEpoch))].map(([, group]) => ({
    dayEpoch: group[0].dayEpoch,
    count: sumBy(group, (r) => r.findingsCount),
  }));
  return fillDailyGaps(grouped, startDayEpoch, endDayEpoch, (dayEpoch) => ({ dayEpoch, count: 0 }));
}

export function resolveSinceMs(since: StatsSinceChoice): number {
  if (since === 'all') return 0;
  const days = Number.parseInt(since, 10);
  const todayStartMs = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return todayStartMs - (days - 1) * DAY_MS;
}
