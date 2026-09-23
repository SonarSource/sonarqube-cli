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

import { openStatsDb } from './db.ts';
import {
  type AggregateRow,
  allTimeAgentHitRate,
  allTimeRuleCounts,
  allTimeSecretRuleCounts,
  attachRuleMessages,
  buildAllTimeFields,
  buildSecretTypeBreakdown,
  buildWindowFields,
  DAY_MS,
  getAggregate,
  parseRow,
  rankTopRules,
  type RawRow,
  resolveSinceMs,
  windowAgentHitRate,
  windowDaily,
  windowDailyDependencyRisks,
  windowDailySecretsBlocked,
  windowRuleCounts,
  windowSecretRuleCounts,
  windowStopped,
} from './stats-aggregation.ts';
import type { StatsAllTimeTotals, StatsSinceChoice, StatsSummary } from './stats-summary-types.ts';

export type {
  StatsAgentHitRate,
  StatsAgentShare,
  StatsAllTimeTotals,
  StatsAnalyzerTotal,
  StatsCallerCommandRuns,
  StatsDailyCount,
  StatsDailyPoint,
  StatsSecretTypeBreakdown,
  StatsSinceChoice,
  StatsStoppedBreakdown,
  StatsStopPoint,
  StatsSummary,
  StatsTopRule,
  StatsTriggerShare,
} from './stats-summary-types.ts';

function queryRuleMessages(
  db: ReturnType<typeof openStatsDb>,
  ruleKeys: ReadonlySet<string>,
): Map<string, string> {
  if (ruleKeys.size === 0) return new Map();
  const placeholders = [...ruleKeys].map(() => '?').join(',');
  const rows = db
    .prepare<{ rule_key: string; message: string }, string[]>(
      `SELECT rule_key, message FROM rule_descriptions WHERE rule_key IN (${placeholders})`,
    )
    .all(...ruleKeys);
  return new Map(rows.map((r) => [r.rule_key, r.message]));
}

function computeAllTime(aggregates: readonly AggregateRow[]): StatsAllTimeTotals {
  const globalAgg = getAggregate(aggregates, 'global', '');
  const scaAgg = getAggregate(aggregates, 'analyzer', 'sca-scanner-cli');
  return {
    totalRuns: globalAgg?.runs ?? 0,
    totalFindings: globalAgg?.findings ?? 0,
    secretsBlockedTotal: globalAgg?.blocked ?? 0,
    dependencyRisksTotal: scaAgg?.findings ?? 0,
  };
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
    const aggregates = db.prepare<AggregateRow, []>('SELECT * FROM stats_aggregates').all();
    const isAllTime = since === 'all';

    const globalAgg = getAggregate(aggregates, 'global', '');
    const allTime = computeAllTime(aggregates);
    const agentBreakdown = aggregates
      .filter((a) => a.dimension === 'agent')
      .map((a) => ({ agent: a.key, runs: a.runs, findings: a.findings }))
      .sort((a, b) => b.findings - a.findings);
    const agentHitRate = isAllTime ? allTimeAgentHitRate(globalAgg) : windowAgentHitRate(rows);
    const firstSeenMs = globalAgg?.first_seen_ms ?? null;

    const ruleCounts = isAllTime ? allTimeRuleCounts(aggregates) : windowRuleCounts(rows);
    const secretRuleCounts = isAllTime
      ? allTimeSecretRuleCounts(aggregates)
      : windowSecretRuleCounts(rows);
    const rankedRules = rankTopRules(ruleCounts);
    const neededRuleKeys = new Set([
      ...rankedRules.map((r) => r.ruleKey),
      ...secretRuleCounts.keys(),
    ]);
    const messages = queryRuleMessages(db, neededRuleKeys);
    const topRules = attachRuleMessages(rankedRules, messages);
    const topSecretTypes = buildSecretTypeBreakdown(secretRuleCounts, messages);

    // No per-stop-point aggregate exists (CLI-1115), so at --since all this only reflects
    // surviving raw rows and can under-count allTime.secretsBlockedTotal after a purge.
    const stopped = windowStopped(rows);

    const todayDayEpoch = Math.floor(Date.now() / DAY_MS);
    // Not Math.min(...rows...): spreading past ~1M elements overflows the call stack.
    const oldestSurvivingDayEpoch = rows.reduce(
      (min, r) => Math.min(r.dayEpoch, min),
      todayDayEpoch,
    );
    const windowStartDayEpoch =
      sinceMs > 0 ? Math.floor(sinceMs / DAY_MS) : oldestSurvivingDayEpoch;
    const rangeStartDayEpoch = Math.min(
      Math.max(windowStartDayEpoch, oldestSurvivingDayEpoch),
      todayDayEpoch,
    );

    const windowDependent = isAllTime
      ? buildAllTimeFields(aggregates, allTime)
      : buildWindowFields(rows);

    return {
      sinceMs,
      ...windowDependent,
      allTime,
      stopped,
      topSecretTypes,
      agentHitRate,
      agentBreakdown,
      topRules,
      daily: windowDaily(rows, rangeStartDayEpoch, todayDayEpoch),
      dailySecretsBlocked: windowDailySecretsBlocked(rows, rangeStartDayEpoch, todayDayEpoch),
      dailyDependencyRisks: windowDailyDependencyRisks(rows, rangeStartDayEpoch, todayDayEpoch),
      firstSeenMs,
    };
  } finally {
    db.close();
  }
}
