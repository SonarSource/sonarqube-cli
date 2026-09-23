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

import type { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { openStatsDb } from '@/core/stats/db.ts';
import { queryStatsSummary } from '@/core/stats/stats-queries.ts';

import { useTempSonarUserHome } from './_helpers.ts';

const DAY_MS = 86_400_000;

interface EventOptions {
  timestampMs: number;
  callerCommand: string;
  exitCode: number | null;
  callerAgent: string;
  runTrigger: 'hooks' | 'manual';
  analyzer: string;
  findingsCount: number;
  ruleCounts?: Record<string, number>;
}

function insertEvent(db: Database, event: EventOptions): void {
  db.prepare(
    `INSERT INTO stats_events (timestamp_ms, event_class, caller_command, exit_code, caller_agent, run_trigger, details)
     VALUES (?, 'analyzer', ?, ?, ?, ?, ?)`,
  ).run(
    event.timestampMs,
    event.callerCommand,
    event.exitCode,
    event.callerAgent,
    event.runTrigger,
    JSON.stringify({
      eventClass: 'analyzer',
      analyzer: event.analyzer,
      findingsCount: event.findingsCount,
      ruleCounts: event.ruleCounts,
    }),
  );
}

function insertRuleMessage(db: Database, ruleKey: string, message: string): void {
  db.prepare(
    'INSERT INTO rule_descriptions (rule_key, message, last_seen_ms) VALUES (?, ?, ?)',
  ).run(ruleKey, message, Date.now());
}

interface AggregateOptions {
  runs?: number;
  findings?: number;
  runsWithFindings?: number;
  blocked?: number;
  firstSeenMs?: number | null;
}

function insertAggregate(
  db: Database,
  dimension: string,
  key: string,
  options: AggregateOptions,
): void {
  db.prepare(
    `INSERT INTO stats_aggregates (dimension, key, runs, findings, runs_with_findings, blocked, first_seen_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    dimension,
    key,
    options.runs ?? 0,
    options.findings ?? 0,
    options.runsWithFindings ?? 0,
    options.blocked ?? 0,
    options.firstSeenMs ?? null,
  );
}

function baseEvent(overrides: Partial<EventOptions> = {}): EventOptions {
  return {
    timestampMs: Date.now(),
    callerCommand: 'analyze secrets',
    exitCode: 0,
    callerAgent: 'claude',
    runTrigger: 'manual',
    analyzer: 'sonar-secrets',
    findingsCount: 0,
    ...overrides,
  };
}

describe('queryStatsSummary', () => {
  useTempSonarUserHome('cli-stats-queries-test-');

  it('returns zero totals and no entitlement-relevant state on an empty ledger', () => {
    const summary = queryStatsSummary('30d');

    expect(summary.totalRuns).toBe(0);
    expect(summary.totalFindings).toBe(0);
    expect(summary.firstSeenMs).toBeNull();
    expect(summary.agentHitRate).toBeNull();
    expect(summary.analyzers).toEqual([]);
  });

  it('windowed totals (7d/14d/30d) come from surviving stats_events rows, not the aggregate', () => {
    const db = openStatsDb();
    insertEvent(db, baseEvent({ findingsCount: 2, ruleCounts: { 'secrets:aws-key': 2 } }));
    insertAggregate(db, 'global', '', { runs: 999, findings: 999 });
    db.close();

    const summary = queryStatsSummary('30d');

    expect(summary.totalRuns).toBe(1);
    expect(summary.totalFindings).toBe(2);
    expect(summary.analyzers).toEqual([{ analyzer: 'sonar-secrets', runs: 1, findings: 2 }]);
  });

  it('windowed agentHitRate comes from surviving stats_events rows, not the all-time aggregate', () => {
    const db = openStatsDb();
    insertEvent(db, baseEvent({ findingsCount: 1 }));
    insertEvent(db, baseEvent({ findingsCount: 0 }));
    insertEvent(db, baseEvent({ findingsCount: 0 }));
    // Deliberately different from the window's real 1-of-3 hit rate above.
    insertAggregate(db, 'global', '', { runs: 999, runsWithFindings: 999 });
    db.close();

    const summary = queryStatsSummary('30d');

    expect(summary.agentHitRate).toEqual({ runsWithFindings: 1, totalRuns: 3 });
  });

  it('excludes rows older than the requested window', () => {
    const db = openStatsDb();
    insertEvent(db, baseEvent({ timestampMs: Date.now() - 60 * DAY_MS }));
    insertEvent(db, baseEvent({ timestampMs: Date.now() }));
    db.close();

    const summary = queryStatsSummary('30d');

    expect(summary.totalRuns).toBe(1);
  });

  it('--since all sources totals and breakdowns from stats_aggregates, not surviving raw rows', () => {
    const db = openStatsDb();
    const trueFirstSeenMs = Date.now() - 400 * DAY_MS;
    insertAggregate(db, 'global', '', {
      runs: 500,
      findings: 300,
      runsWithFindings: 200,
      blocked: 40,
      firstSeenMs: trueFirstSeenMs,
    });
    insertAggregate(db, 'analyzer', 'sonar-secrets', { runs: 500, findings: 300 });
    insertAggregate(db, 'agent', 'claude', { runs: 500, findings: 300 });
    // Only one row survives retention — far short of the true history above.
    insertEvent(db, baseEvent({ findingsCount: 1 }));
    db.close();

    const summary = queryStatsSummary('all');

    expect(summary.totalRuns).toBe(500);
    expect(summary.totalFindings).toBe(300);
    expect(summary.firstSeenMs).toBe(trueFirstSeenMs);
    expect(summary.agentHitRate).toEqual({ runsWithFindings: 200, totalRuns: 500 });
    expect(summary.analyzers).toEqual([{ analyzer: 'sonar-secrets', runs: 500, findings: 300 }]);
  });

  it('--since all attributes topSecretTypes findings to the right rule even when a non-secrets rule aggregate sorts earlier', () => {
    const db = openStatsDb();
    insertRuleMessage(db, 'secrets:aws-key', 'AWS access keys should not be disclosed');
    insertRuleMessage(db, 'secrets:github-token', 'GitHub tokens should not be disclosed');
    // Inserted before the secrets rows so a naive re-index-by-position after filtering
    // by analyzer would pull this row's findings instead.
    insertAggregate(db, 'rule', 'sqaa:typescript:S1234', { findings: 999 });
    insertAggregate(db, 'rule', 'sonar-secrets:secrets:aws-key', { findings: 50 });
    insertAggregate(db, 'rule', 'sonar-secrets:secrets:github-token', { findings: 30 });
    db.close();

    const summary = queryStatsSummary('all');

    expect(summary.topSecretTypes).toEqual([
      { label: 'AWS access keys', count: 50 },
      { label: 'GitHub tokens', count: 30 },
    ]);
  });

  it('--since all sums a shared rule key across analyzers instead of one overwriting the other', () => {
    const db = openStatsDb();
    insertRuleMessage(db, 'shared:S6290', 'Shared rule message');
    // Neither row alone reaches TOP_RULES_MIN_COUNT (10); only their sum does.
    insertAggregate(db, 'rule', 'sonar-secrets:shared:S6290', { findings: 6 });
    insertAggregate(db, 'rule', 'sqaa:shared:S6290', { findings: 6 });
    db.close();

    const summary = queryStatsSummary('all');

    expect(summary.topRules).toEqual([
      { ruleKey: 'shared:S6290', count: 12, message: 'Shared rule message' },
    ]);
  });

  it('known gap: at --since all, `stopped` reflects only surviving rows, unlike allTime.secretsBlockedTotal', () => {
    const db = openStatsDb();
    insertAggregate(db, 'global', '', { blocked: 40 });
    insertEvent(
      db,
      baseEvent({ callerCommand: 'git-pre-commit', runTrigger: 'hooks', exitCode: 51 }),
    );
    db.close();

    const summary = queryStatsSummary('all');

    expect(summary.allTime.secretsBlockedTotal).toBe(40);
    expect(summary.stopped).toEqual([{ point: 'commit', count: 1 }]);
  });

  it('fills days with no activity as zero in the daily series', () => {
    const db = openStatsDb();
    insertEvent(db, baseEvent({ timestampMs: Date.now() - 2 * DAY_MS }));
    insertEvent(db, baseEvent({ timestampMs: Date.now() }));
    db.close();

    const summary = queryStatsSummary('7d');

    const runsByDay = summary.daily.map((d) => d.runs);
    expect(runsByDay.filter((runs) => runs === 0).length).toBeGreaterThanOrEqual(1);
    expect(runsByDay.reduce((sum, runs) => sum + runs, 0)).toBe(2);
  });

  it('derives a secret type label by stripping the disclosure suffix, bucketing the rest as "others"', () => {
    const db = openStatsDb();
    insertRuleMessage(db, 'secrets:aws-key', 'AWS access keys should not be disclosed');
    insertRuleMessage(db, 'secrets:github-token', 'GitHub tokens should not be disclosed');
    insertRuleMessage(db, 'secrets:slack-webhook', 'Slack webhook URLs must not be disclosed.');
    insertEvent(
      db,
      baseEvent({
        findingsCount: 1,
        ruleCounts: { 'secrets:aws-key': 5, 'secrets:github-token': 3 },
      }),
    );
    insertEvent(
      db,
      baseEvent({
        timestampMs: Date.now() - 1,
        findingsCount: 1,
        ruleCounts: { 'secrets:slack-webhook': 1 },
      }),
    );
    db.close();

    const summary = queryStatsSummary('30d');

    expect(summary.topSecretTypes).toEqual([
      { label: 'AWS access keys', count: 5 },
      { label: 'GitHub tokens', count: 3 },
      { label: 'others', count: 1 },
    ]);
  });

  it('excludes rules below the minimum occurrence count from topRules', () => {
    const db = openStatsDb();
    insertEvent(
      db,
      baseEvent({
        analyzer: 'sqaa',
        findingsCount: 9,
        ruleCounts: { 'typescript:S1234': 9 },
      }),
    );
    db.close();

    const summary = queryStatsSummary('30d');

    expect(summary.topRules).toEqual([]);
  });
});
