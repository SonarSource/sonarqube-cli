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

import { openStatsDb } from './db.ts';

const DAY_MS = 86_400_000;

export type StatsSinceChoice = '7d' | '14d' | '30d' | 'all';
export type StatsStopPoint = 'commit' | 'push' | 'prompt' | 'file-read';

export interface StatsAnalyzerTotal {
  analyzer: string;
  runs: number;
  findings: number;
}
export interface StatsStoppedBreakdown {
  point: StatsStopPoint;
  count: number;
}
export interface StatsAgentHitRate {
  runsWithFindings: number;
  totalRuns: number;
}
export interface StatsAgentShare {
  agent: string;
  runs: number;
  findings: number;
}
export interface StatsTriggerShare {
  trigger: string;
  runs: number;
}
export interface StatsTopRule {
  ruleKey: string;
  count: number;
  message: string | null;
}
export interface StatsDailyPoint {
  dayEpoch: number;
  runs: number;
  findings: number;
}
export interface StatsDailyCount {
  dayEpoch: number;
  count: number;
}
export interface StatsAllTimeTotals {
  totalRuns: number;
  totalFindings: number;
  secretsBlockedTotal: number;
  dependencyRisksTotal: number;
}
export interface StatsSecretTypeBreakdown {
  label: string;
  count: number;
}
export interface StatsCallerCommandRuns {
  command: string;
  runs: number;
}

export interface StatsSummary {
  sinceMs: number;
  totalRuns: number;
  totalFindings: number;
  allTime: StatsAllTimeTotals;
  analyzers: StatsAnalyzerTotal[];
  stopped: StatsStoppedBreakdown[];
  topSecretTypes: StatsSecretTypeBreakdown[];
  agentHitRate: StatsAgentHitRate | null;
  agentBreakdown: StatsAgentShare[];
  callerCommandBreakdown: StatsCallerCommandRuns[];
  triggers: StatsTriggerShare[];
  topRules: StatsTopRule[];
  daily: StatsDailyPoint[];
  dailySecretsBlocked: StatsDailyCount[];
  dailyDependencyRisks: StatsDailyCount[];
  firstSeenMs: number | null;
}

interface RawRow {
  timestamp_ms: number;
  caller_command: string;
  exit_code: number | null;
  caller_agent: string;
  run_trigger: string;
  details: string;
}

interface ParsedRow {
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

interface AggregateRow {
  dimension: string;
  key: string;
  runs: number;
  findings: number;
  runs_with_findings: number;
  blocked: number;
  first_seen_ms: number | null;
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

function parseRow(row: RawRow): ParsedRow {
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

function windowAnalyzers(rows: readonly ParsedRow[]): StatsAnalyzerTotal[] {
  return [...groupCounts(rows, (r) => r.analyzer)].map(([analyzer, group]) => ({
    analyzer,
    runs: group.length,
    findings: sumBy(group, (r) => r.findingsCount),
  }));
}

function windowTriggers(rows: readonly ParsedRow[]): StatsTriggerShare[] {
  return [...groupCounts(rows, (r) => r.runTrigger)].map(([trigger, group]) => ({
    trigger,
    runs: group.length,
  }));
}

function windowCallerCommands(rows: readonly ParsedRow[]): StatsCallerCommandRuns[] {
  return [...groupCounts(rows, (r) => r.callerCommand)]
    .map(([command, group]) => ({ command, runs: group.length }))
    .sort((a, b) => b.runs - a.runs);
}

function windowStopped(rows: readonly ParsedRow[]): StatsStoppedBreakdown[] {
  const blocked = rows.filter((r) => r.isSecretsBlocked && r.stopPoint);
  return [...groupCounts(blocked, (r) => r.stopPoint as string)].map(([point, group]) => ({
    point: point as StatsStopPoint,
    count: group.length,
  }));
}

function windowAgentHitRate(rows: readonly ParsedRow[]): StatsAgentHitRate | null {
  if (rows.length === 0) return null;
  const runsWithFindings = rows.filter((r) => r.findingsCount > 0).length;
  return { runsWithFindings, totalRuns: rows.length };
}

function ruleMessages(db: ReturnType<typeof openStatsDb>): Map<string, string> {
  const rows = db
    .prepare<{ rule_key: string; message: string }, []>(
      'SELECT rule_key, message FROM rule_descriptions',
    )
    .all();
  return new Map(rows.map((r) => [r.rule_key, r.message]));
}

function windowTopRules(rows: readonly ParsedRow[], messages: Map<string, string>): StatsTopRule[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const [ruleKey, count] of Object.entries(row.ruleCounts)) {
      counts.set(ruleKey, (counts.get(ruleKey) ?? 0) + count);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= TOP_RULES_MIN_COUNT)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_RULES_LIMIT)
    .map(([ruleKey, count]) => ({ ruleKey, count, message: messages.get(ruleKey) ?? null }));
}

function buildSecretTypeBreakdown(
  entries: ReadonlyArray<[string, number]>,
  messages: Map<string, string>,
): StatsSecretTypeBreakdown[] {
  const countByLabel = new Map<string, number>();
  for (const [ruleKey, count] of entries) {
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

function windowTopSecretTypes(
  rows: readonly ParsedRow[],
  messages: Map<string, string>,
): StatsSecretTypeBreakdown[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.analyzer !== 'sonar-secrets') continue;
    for (const [ruleKey, count] of Object.entries(row.ruleCounts)) {
      counts.set(ruleKey, (counts.get(ruleKey) ?? 0) + count);
    }
  }
  return buildSecretTypeBreakdown([...counts.entries()], messages);
}

function windowDaily(
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

function windowDailySecretsBlocked(
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

function windowDailyDependencyRisks(
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

function getAggregate(
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

function allTimeTopRules(
  aggregates: readonly AggregateRow[],
  messages: Map<string, string>,
): StatsTopRule[] {
  const ruleRows = aggregates.filter((a) => a.dimension === 'rule');
  return ruleRows
    .map((a) => ({ ruleKey: splitRuleAggregateKey(a.key).ruleKey, count: a.findings }))
    .filter((r) => r.count >= TOP_RULES_MIN_COUNT)
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_RULES_LIMIT)
    .map((r) => ({ ...r, message: messages.get(r.ruleKey) ?? null }));
}

function allTimeTopSecretTypes(
  aggregates: readonly AggregateRow[],
  messages: Map<string, string>,
): StatsSecretTypeBreakdown[] {
  const entries = aggregates
    .filter((a) => a.dimension === 'rule')
    .map((a) => ({ ...splitRuleAggregateKey(a.key), findings: a.findings }))
    .filter((r) => r.analyzer === 'sonar-secrets')
    .map((r): [string, number] => [r.ruleKey, r.findings]);
  return buildSecretTypeBreakdown(entries, messages);
}

function allTimeAgentHitRate(globalAgg: AggregateRow | undefined): StatsAgentHitRate | null {
  if (!globalAgg || globalAgg.runs === 0) return null;
  return { runsWithFindings: globalAgg.runs_with_findings, totalRuns: globalAgg.runs };
}

function resolveSinceMs(since: StatsSinceChoice): number {
  if (since === 'all') return 0;
  const days = Number.parseInt(since, 10);
  const todayStartMs = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  return todayStartMs - (days - 1) * DAY_MS;
}

/** Reads and aggregates the local stats ledger for `sonar stats`.
 *  @param since Time window; `'all'` reads all-time figures from `stats_aggregates` instead
 *    of the (purge-bounded) raw `stats_events` rows.
 *  @returns The summary the text and `--json` renderers both build from. */
export function queryStatsSummary(since: StatsSinceChoice): StatsSummary {
  const db = openStatsDb();
  try {
    const sinceMs = resolveSinceMs(since);
    const rawRows = db
      .prepare<RawRow, [number]>(
        `SELECT timestamp_ms, caller_command, exit_code, caller_agent, run_trigger, details
         FROM stats_events WHERE event_class = 'analyzer' AND timestamp_ms >= ?`,
      )
      .all(sinceMs);
    const rows = rawRows.map(parseRow);
    const messages = ruleMessages(db);
    const aggregates = db.prepare<AggregateRow, []>('SELECT * FROM stats_aggregates').all();
    const isAllTime = since === 'all';

    const globalAgg = getAggregate(aggregates, 'global', '');
    const scaAgg = getAggregate(aggregates, 'analyzer', 'sca-scanner-cli');
    const allTime: StatsAllTimeTotals = {
      totalRuns: globalAgg?.runs ?? 0,
      totalFindings: globalAgg?.findings ?? 0,
      secretsBlockedTotal: globalAgg?.blocked ?? 0,
      dependencyRisksTotal: scaAgg?.findings ?? 0,
    };
    const agentBreakdown = aggregates
      .filter((a) => a.dimension === 'agent')
      .map((a) => ({ agent: a.key, runs: a.runs, findings: a.findings }))
      .sort((a, b) => b.findings - a.findings);
    const agentHitRate: StatsAgentHitRate | null = isAllTime
      ? allTimeAgentHitRate(globalAgg)
      : windowAgentHitRate(rows);
    const firstSeenMs = globalAgg?.first_seen_ms ?? null;

    const todayDayEpoch = Math.floor(Date.now() / DAY_MS);
    const oldestSurvivingDayEpoch =
      rows.length > 0 ? Math.min(...rows.map((r) => r.dayEpoch)) : todayDayEpoch;
    const windowStartDayEpoch =
      sinceMs > 0 ? Math.floor(sinceMs / DAY_MS) : oldestSurvivingDayEpoch;
    const rangeStartDayEpoch = Math.min(
      Math.max(windowStartDayEpoch, oldestSurvivingDayEpoch),
      todayDayEpoch,
    );

    return {
      sinceMs,
      totalRuns: isAllTime ? allTime.totalRuns : rows.length,
      totalFindings: isAllTime ? allTime.totalFindings : sumBy(rows, (r) => r.findingsCount),
      allTime,
      analyzers: isAllTime
        ? aggregates
            .filter((a) => a.dimension === 'analyzer')
            .map((a) => ({ analyzer: a.key, runs: a.runs, findings: a.findings }))
        : windowAnalyzers(rows),
      // No per-stop-point aggregate exists (CLI-1115), so at --since all this only reflects
      // surviving raw rows and can under-count allTime.secretsBlockedTotal after a purge.
      stopped: windowStopped(rows),
      topSecretTypes: isAllTime
        ? allTimeTopSecretTypes(aggregates, messages)
        : windowTopSecretTypes(rows, messages),
      agentHitRate,
      agentBreakdown,
      callerCommandBreakdown: isAllTime
        ? aggregates
            .filter((a) => a.dimension === 'caller_command')
            .map((a) => ({ command: a.key, runs: a.runs }))
            .sort((a, b) => b.runs - a.runs)
        : windowCallerCommands(rows),
      triggers: isAllTime
        ? aggregates
            .filter((a) => a.dimension === 'trigger')
            .map((a) => ({ trigger: a.key, runs: a.runs }))
        : windowTriggers(rows),
      topRules: isAllTime ? allTimeTopRules(aggregates, messages) : windowTopRules(rows, messages),
      daily: windowDaily(rows, rangeStartDayEpoch, todayDayEpoch),
      dailySecretsBlocked: windowDailySecretsBlocked(rows, rangeStartDayEpoch, todayDayEpoch),
      dailyDependencyRisks: windowDailyDependencyRisks(rows, rangeStartDayEpoch, todayDayEpoch),
      firstSeenMs,
    };
  } finally {
    db.close();
  }
}
