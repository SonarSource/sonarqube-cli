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

import { openStatsDb, type StatsAnalyzer, type StatsTrigger } from './stats-store.ts';

export interface StatsAnalyzerTotal {
  analyzer: StatsAnalyzer;
  runs: number;
  findings: number;
}

export type StatsStopPoint = 'commit' | 'push' | 'prompt' | 'file-read';

export interface StatsStoppedBreakdown {
  point: StatsStopPoint;
  count: number;
}

const STOP_POINT_BY_CALLER_COMMAND: Partial<Record<string, StatsStopPoint>> = {
  'git-pre-commit': 'commit',
  'git-pre-push': 'push',
  'agent-prompt-submit': 'prompt',
  'cursor-prompt-submit': 'prompt',
  'claude-pre-tool-use': 'file-read',
  'copilot-pre-tool-use': 'file-read',
  'antigravity-pre-tool-use': 'file-read',
  'cursor-pre-file-read': 'file-read',
  'cursor-pre-tool-use': 'file-read',
};

const STOP_MAPPED_CALLER_COMMANDS = Object.keys(STOP_POINT_BY_CALLER_COMMAND);
const STOP_MAPPED_PLACEHOLDERS = STOP_MAPPED_CALLER_COMMANDS.map(() => '?').join(', ');

function aggregateStopPoints(
  rows: ReadonlyArray<{ callerCommand: string; blocked: number }>,
): StatsStoppedBreakdown[] {
  const totals = new Map<StatsStopPoint, number>();
  for (const row of rows) {
    const point = STOP_POINT_BY_CALLER_COMMAND[row.callerCommand];
    if (!point) continue;
    totals.set(point, (totals.get(point) ?? 0) + row.blocked);
  }
  return [...totals.entries()].map(([point, count]) => ({ point, count }));
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
  trigger: StatsTrigger;
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

const TOP_RULES_LIMIT = 5;
const TOP_RULES_MIN_COUNT = 10;

const TOP_SECRET_TYPES_LIMIT = 2;
const SECRET_TYPE_OTHERS_LABEL = 'others';
const SECRET_TYPE_SUFFIX_PATTERN = / (?:should|must) not be disclosed\.?$/i;

const SECRETS_BLOCKED_EXIT_CODE = 51;

const DAY_MS = 86_400_000;

function deriveSecretTypeLabel(message: string | null, ruleKey: string): string {
  if (!message) return ruleKey;
  return message.replace(SECRET_TYPE_SUFFIX_PATTERN, '').trim() || ruleKey;
}

function buildSecretTypeBreakdown(
  rows: ReadonlyArray<{ ruleKey: string; count: number; message: string | null }>,
): StatsSecretTypeBreakdown[] {
  const countByLabel = new Map<string, number>();
  for (const row of rows) {
    const label = deriveSecretTypeLabel(row.message, row.ruleKey);
    countByLabel.set(label, (countByLabel.get(label) ?? 0) + row.count);
  }
  const sorted = [...countByLabel.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, TOP_SECRET_TYPES_LIMIT).map(([label, count]) => ({ label, count }));
  const othersCount = sorted
    .slice(TOP_SECRET_TYPES_LIMIT)
    .reduce((sum, [, count]) => sum + count, 0);
  if (othersCount > 0) {
    top.push({ label: SECRET_TYPE_OTHERS_LABEL, count: othersCount });
  }
  return top;
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

export function queryStatsSummary(sinceMs: number): StatsSummary {
  const db = openStatsDb();
  try {
    const totalRow = db
      .prepare<{ runs: number; findings: number }, [number]>(
        `SELECT COUNT(*) as runs, COALESCE(SUM(d.findings_count), 0) as findings
         FROM stats_events e
         JOIN analyzer_event_details d ON d.event_id = e.id
         WHERE e.timestamp_ms >= ?`,
      )
      .get(sinceMs);

    const firstSeenRow = db
      .prepare<{ firstSeenMs: number | null }, []>(
        'SELECT MIN(timestamp_ms) as firstSeenMs FROM stats_events',
      )
      .get();
    const todayDayEpoch = Math.floor(Date.now() / DAY_MS);
    const firstSeenDayEpoch =
      firstSeenRow?.firstSeenMs != null
        ? Math.floor(firstSeenRow.firstSeenMs / DAY_MS)
        : todayDayEpoch;
    const windowStartDayEpoch = sinceMs > 0 ? Math.floor(sinceMs / DAY_MS) : firstSeenDayEpoch;
    const rangeStartDayEpoch = Math.min(
      Math.max(windowStartDayEpoch, firstSeenDayEpoch),
      todayDayEpoch,
    );

    const analyzers = db
      .prepare<StatsAnalyzerTotal, [number]>(
        `SELECT d.analyzer as analyzer, COUNT(*) as runs, COALESCE(SUM(d.findings_count), 0) as findings
         FROM stats_events e
         JOIN analyzer_event_details d ON d.event_id = e.id
         WHERE e.timestamp_ms >= ? GROUP BY d.analyzer`,
      )
      .all(sinceMs);

    const blockedRows = db
      .prepare<{ callerCommand: string; blocked: number }, [number, number]>(
        `SELECT e.caller_command as callerCommand, COUNT(*) as blocked
         FROM stats_events e
         JOIN analyzer_event_details d ON d.event_id = e.id
         WHERE d.analyzer = 'sonar-secrets' AND e.exit_code = ? AND e.timestamp_ms >= ?
         GROUP BY e.caller_command`,
      )
      .all(SECRETS_BLOCKED_EXIT_CODE, sinceMs);
    const stopped = aggregateStopPoints(blockedRows);

    const allTimeTotalRow = db
      .prepare<{ runs: number; findings: number }, []>(
        `SELECT COUNT(*) as runs, COALESCE(SUM(d.findings_count), 0) as findings
         FROM stats_events e
         JOIN analyzer_event_details d ON d.event_id = e.id`,
      )
      .get();
    const allTimeBlockedRow = db
      .prepare<{ blocked: number }, [number, ...string[]]>(
        `SELECT COUNT(*) as blocked
         FROM stats_events e
         JOIN analyzer_event_details d ON d.event_id = e.id
         WHERE d.analyzer = 'sonar-secrets' AND e.exit_code = ?
           AND e.caller_command IN (${STOP_MAPPED_PLACEHOLDERS})`,
      )
      .get(SECRETS_BLOCKED_EXIT_CODE, ...STOP_MAPPED_CALLER_COMMANDS);
    const allTimeScaRow = db
      .prepare<{ findings: number }, []>(
        `SELECT COALESCE(SUM(d.findings_count), 0) as findings
         FROM stats_events e
         JOIN analyzer_event_details d ON d.event_id = e.id
         WHERE d.analyzer = 'sca-scanner-cli'`,
      )
      .get();
    const allTime: StatsAllTimeTotals = {
      totalRuns: allTimeTotalRow?.runs ?? 0,
      totalFindings: allTimeTotalRow?.findings ?? 0,
      secretsBlockedTotal: allTimeBlockedRow?.blocked ?? 0,
      dependencyRisksTotal: allTimeScaRow?.findings ?? 0,
    };

    const secretRuleRows = db
      .prepare<{ ruleKey: string; count: number; message: string | null }, [number]>(
        `SELECT r.rule_key as ruleKey, SUM(r.count) as count, MAX(rd.message) as message
         FROM analysis_event_rule_counts r
         JOIN analyzer_event_details d ON d.event_id = r.event_id
         JOIN stats_events e ON e.id = r.event_id
         LEFT JOIN rule_descriptions rd ON rd.rule_key = r.rule_key
         WHERE d.analyzer = 'sonar-secrets' AND e.timestamp_ms >= ?
         GROUP BY r.rule_key`,
      )
      .all(sinceMs);
    const topSecretTypes = buildSecretTypeBreakdown(secretRuleRows);

    const agentHitRow = db
      .prepare<{ totalRuns: number; runsWithFindings: number }, []>(
        `SELECT COUNT(*) as totalRuns,
                COALESCE(SUM(CASE WHEN d.findings_count > 0 THEN 1 ELSE 0 END), 0) as runsWithFindings
         FROM stats_events e
         JOIN analyzer_event_details d ON d.event_id = e.id`,
      )
      .get();
    const agentHitRate = agentHitRow && agentHitRow.totalRuns > 0 ? agentHitRow : null;

    const agentBreakdown = db
      .prepare<StatsAgentShare, []>(
        `SELECT e.caller_agent as agent, COUNT(*) as runs, COALESCE(SUM(d.findings_count), 0) as findings
         FROM stats_events e
         JOIN analyzer_event_details d ON d.event_id = e.id
         GROUP BY e.caller_agent ORDER BY findings DESC`,
      )
      .all();

    const triggers = db
      .prepare<StatsTriggerShare, [number]>(
        `SELECT run_trigger as trigger, COUNT(*) as runs
         FROM stats_events WHERE timestamp_ms >= ? GROUP BY run_trigger`,
      )
      .all(sinceMs);

    const callerCommandBreakdown = db
      .prepare<StatsCallerCommandRuns, [number]>(
        `SELECT caller_command as command, COUNT(*) as runs
         FROM stats_events WHERE timestamp_ms >= ? GROUP BY caller_command ORDER BY runs DESC`,
      )
      .all(sinceMs);

    const topRules = db
      .prepare<StatsTopRule, [number, number, number]>(
        `SELECT r.rule_key as ruleKey, SUM(r.count) as count, MAX(rd.message) as message
         FROM analysis_event_rule_counts r
         JOIN stats_events e ON e.id = r.event_id
         LEFT JOIN rule_descriptions rd ON rd.rule_key = r.rule_key
         WHERE e.timestamp_ms >= ?
         GROUP BY r.rule_key
         HAVING SUM(r.count) >= ?
         ORDER BY count DESC LIMIT ?`,
      )
      .all(sinceMs, TOP_RULES_MIN_COUNT, TOP_RULES_LIMIT);

    const dailyRows = db
      .prepare<StatsDailyPoint, [number]>(
        `SELECT (e.timestamp_ms / ${DAY_MS}) as dayEpoch, COUNT(*) as runs, COALESCE(SUM(d.findings_count), 0) as findings
         FROM stats_events e
         JOIN analyzer_event_details d ON d.event_id = e.id
         WHERE e.timestamp_ms >= ? GROUP BY dayEpoch ORDER BY dayEpoch`,
      )
      .all(sinceMs);
    const daily = fillDailyGaps(dailyRows, rangeStartDayEpoch, todayDayEpoch, (dayEpoch) => ({
      dayEpoch,
      runs: 0,
      findings: 0,
    }));

    const dailySecretsBlockedRows = db
      .prepare<StatsDailyCount, [number, number, ...string[]]>(
        `SELECT (e.timestamp_ms / ${DAY_MS}) as dayEpoch, COUNT(*) as count
         FROM stats_events e
         JOIN analyzer_event_details d ON d.event_id = e.id
         WHERE d.analyzer = 'sonar-secrets' AND e.exit_code = ? AND e.timestamp_ms >= ?
           AND e.caller_command IN (${STOP_MAPPED_PLACEHOLDERS})
         GROUP BY dayEpoch ORDER BY dayEpoch`,
      )
      .all(SECRETS_BLOCKED_EXIT_CODE, sinceMs, ...STOP_MAPPED_CALLER_COMMANDS);
    const dailySecretsBlocked = fillDailyGaps(
      dailySecretsBlockedRows,
      rangeStartDayEpoch,
      todayDayEpoch,
      (dayEpoch) => ({ dayEpoch, count: 0 }),
    );

    const dailyDependencyRisksRows = db
      .prepare<StatsDailyCount, [number]>(
        `SELECT (e.timestamp_ms / ${DAY_MS}) as dayEpoch, COALESCE(SUM(d.findings_count), 0) as count
         FROM stats_events e
         JOIN analyzer_event_details d ON d.event_id = e.id
         WHERE d.analyzer = 'sca-scanner-cli' AND e.timestamp_ms >= ?
         GROUP BY dayEpoch ORDER BY dayEpoch`,
      )
      .all(sinceMs);
    const dailyDependencyRisks = fillDailyGaps(
      dailyDependencyRisksRows,
      rangeStartDayEpoch,
      todayDayEpoch,
      (dayEpoch) => ({ dayEpoch, count: 0 }),
    );

    return {
      sinceMs,
      totalRuns: totalRow?.runs ?? 0,
      totalFindings: totalRow?.findings ?? 0,
      allTime,
      analyzers,
      stopped,
      topSecretTypes,
      agentHitRate,
      agentBreakdown,
      callerCommandBreakdown,
      triggers,
      topRules,
      daily,
      dailySecretsBlocked,
      dailyDependencyRisks,
      firstSeenMs: firstSeenRow?.firstSeenMs ?? null,
    };
  } finally {
    db.close();
  }
}
