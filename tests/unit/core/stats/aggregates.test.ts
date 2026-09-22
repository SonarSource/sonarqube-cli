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

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { SECRETS_CALLER_COMMANDS } from '@/commands/analyze/secrets-analysis-telemetry.ts';
import {
  type AnalyzerAggregateEvent,
  applyAnalyzerEventToAggregates,
} from '@/core/stats/aggregates.ts';
import { applyStatsMigrations } from '@/core/stats/migrations.ts';

import { readStatsAggregateFromDb as readAggregate } from '../../../_common/stats-helpers.ts';

function baseEvent(overrides: Partial<AnalyzerAggregateEvent> = {}): AnalyzerAggregateEvent {
  return {
    timestampMs: 1000,
    callerCommand: 'analyze secrets',
    exitCode: 0,
    callerAgent: 'claude',
    runTrigger: 'manual',
    analyzer: 'sonar-secrets',
    findingsCount: 0,
    ...overrides,
  };
}

function freshDb(): Database {
  const db = new Database(':memory:');
  applyStatsMigrations(db);
  return db;
}

describe('applyAnalyzerEventToAggregates', () => {
  it('increments the global row cumulatively across calls', () => {
    const db = freshDb();

    applyAnalyzerEventToAggregates(db, baseEvent({ findingsCount: 2, timestampMs: 100 }));
    applyAnalyzerEventToAggregates(db, baseEvent({ findingsCount: 0, timestampMs: 200 }));

    expect(readAggregate(db, 'global', '')).toEqual({
      runs: 2,
      findings: 2,
      runs_with_findings: 1,
      blocked: 0,
      first_seen_ms: 100,
    });
  });

  it('keeps the earliest first_seen_ms regardless of call order', () => {
    const db = freshDb();

    applyAnalyzerEventToAggregates(db, baseEvent({ timestampMs: 500 }));
    applyAnalyzerEventToAggregates(db, baseEvent({ timestampMs: 100 }));
    applyAnalyzerEventToAggregates(db, baseEvent({ timestampMs: 900 }));

    expect(readAggregate(db, 'global', '')?.first_seen_ms).toBe(100);
  });

  it('counts a run as blocked only for sonar-secrets, exit code 51, at a known stop point', () => {
    const db = freshDb();

    applyAnalyzerEventToAggregates(
      db,
      baseEvent({ analyzer: 'sonar-secrets', exitCode: 51, callerCommand: 'git-pre-commit' }),
    );
    applyAnalyzerEventToAggregates(
      db,
      baseEvent({ analyzer: 'sonar-secrets', exitCode: 51, callerCommand: 'analyze secrets' }),
    );
    applyAnalyzerEventToAggregates(
      db,
      baseEvent({ analyzer: 'sqaa', exitCode: 51, callerCommand: 'git-pre-commit' }),
    );
    applyAnalyzerEventToAggregates(
      db,
      baseEvent({ analyzer: 'sonar-secrets', exitCode: 0, callerCommand: 'git-pre-commit' }),
    );

    expect(readAggregate(db, 'global', '')?.blocked).toBe(1);
  });

  it('breaks down runs and findings per analyzer and per caller agent', () => {
    const db = freshDb();

    applyAnalyzerEventToAggregates(
      db,
      baseEvent({ analyzer: 'sqaa', callerAgent: 'claude', findingsCount: 3 }),
    );
    applyAnalyzerEventToAggregates(
      db,
      baseEvent({ analyzer: 'sqaa', callerAgent: 'cursor', findingsCount: 1 }),
    );
    applyAnalyzerEventToAggregates(
      db,
      baseEvent({ analyzer: 'sca-scanner-cli', callerAgent: 'claude', findingsCount: 5 }),
    );

    expect(readAggregate(db, 'analyzer', 'sqaa')).toMatchObject({ runs: 2, findings: 4 });
    expect(readAggregate(db, 'analyzer', 'sca-scanner-cli')).toMatchObject({
      runs: 1,
      findings: 5,
    });
    expect(readAggregate(db, 'agent', 'claude')).toMatchObject({ runs: 2, findings: 8 });
    expect(readAggregate(db, 'agent', 'cursor')).toMatchObject({ runs: 1, findings: 1 });
  });

  it('breaks down runs per trigger and per caller command', () => {
    const db = freshDb();

    applyAnalyzerEventToAggregates(
      db,
      baseEvent({ runTrigger: 'manual', callerCommand: 'analyze secrets' }),
    );
    applyAnalyzerEventToAggregates(
      db,
      baseEvent({ runTrigger: 'hooks', callerCommand: 'git-pre-commit' }),
    );
    applyAnalyzerEventToAggregates(
      db,
      baseEvent({ runTrigger: 'hooks', callerCommand: 'git-pre-commit' }),
    );

    expect(readAggregate(db, 'trigger', 'manual')?.runs).toBe(1);
    expect(readAggregate(db, 'trigger', 'hooks')?.runs).toBe(2);
    expect(readAggregate(db, 'caller_command', 'git-pre-commit')?.runs).toBe(2);
  });

  it('keys rule counts by "<analyzer>:<ruleKey>" and accumulates across runs', () => {
    const db = freshDb();

    applyAnalyzerEventToAggregates(
      db,
      baseEvent({
        analyzer: 'sqaa',
        findingsCount: 2,
        ruleCounts: { 'typescript:S1234': 2 },
      }),
    );
    applyAnalyzerEventToAggregates(
      db,
      baseEvent({
        analyzer: 'sqaa',
        findingsCount: 1,
        ruleCounts: { 'typescript:S1234': 1 },
      }),
    );

    expect(readAggregate(db, 'rule', 'sqaa:typescript:S1234')?.findings).toBe(3);
  });

  it('does not create a rule row when no ruleCounts are given', () => {
    const db = freshDb();

    applyAnalyzerEventToAggregates(db, baseEvent({ findingsCount: 0 }));

    const rows = db.prepare("SELECT * FROM stats_aggregates WHERE dimension = 'rule'").all();
    expect(rows).toHaveLength(0);
  });
});

describe('isSecretsBlocked classification (drift protection)', () => {
  const EXPECTED_BLOCKED: Record<keyof typeof SECRETS_CALLER_COMMANDS, boolean> = {
    analyze: false,
    analyzeSecrets: false,
    analyzeDependencyRisks: false,
    gitPreCommit: true,
    gitPrePush: true,
    agentPromptSubmit: true,
    cursorPromptSubmit: true,
    claudePreToolUse: true,
    copilotPreToolUse: true,
    antigravityPreToolUse: true,
    cursorPreFileRead: true,
    cursorPreToolUse: true,
  };

  it.each(
    (Object.keys(EXPECTED_BLOCKED) as Array<keyof typeof SECRETS_CALLER_COMMANDS>).map(
      (key) => [SECRETS_CALLER_COMMANDS[key], EXPECTED_BLOCKED[key]] as const,
    ),
  )('classifies "%s" as blocked=%s', (callerCommand, expectedBlocked) => {
    const db = freshDb();

    applyAnalyzerEventToAggregates(db, baseEvent({ callerCommand, exitCode: 51 }));

    expect(readAggregate(db, 'global', '')?.blocked).toBe(expectedBlocked ? 1 : 0);
  });
});
