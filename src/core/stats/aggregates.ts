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

import { EXIT_CODE_SECRETS_FOUND, SECRETS_CALLER_COMMANDS } from '@/core/config-constants.ts';

const SECRETS_BLOCKED_CALLER_COMMANDS: ReadonlySet<string> = new Set([
  SECRETS_CALLER_COMMANDS.gitPreCommit,
  SECRETS_CALLER_COMMANDS.gitPrePush,
  SECRETS_CALLER_COMMANDS.agentPromptSubmit,
  SECRETS_CALLER_COMMANDS.cursorPromptSubmit,
  SECRETS_CALLER_COMMANDS.claudePreToolUse,
  SECRETS_CALLER_COMMANDS.copilotPreToolUse,
  SECRETS_CALLER_COMMANDS.antigravityPreToolUse,
  SECRETS_CALLER_COMMANDS.cursorPreFileRead,
  SECRETS_CALLER_COMMANDS.cursorPreToolUse,
]);

export interface AnalyzerAggregateEvent {
  timestampMs: number;
  callerCommand: string;
  exitCode: number | null;
  callerAgent: string;
  runTrigger: 'hooks' | 'manual';
  analyzer: string;
  findingsCount: number;
  ruleCounts?: Record<string, number>;
}

function isSecretsBlocked(event: AnalyzerAggregateEvent): boolean {
  return (
    event.analyzer === 'sonar-secrets' &&
    event.exitCode === EXIT_CODE_SECRETS_FOUND &&
    SECRETS_BLOCKED_CALLER_COMMANDS.has(event.callerCommand)
  );
}

function upsertCounterRow(
  db: Database,
  dimension: string,
  key: string,
  runsDelta: number,
  findingsDelta: number,
): void {
  db.prepare(
    `INSERT INTO stats_aggregates (dimension, key, runs, findings)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (dimension, key) DO UPDATE SET
       runs = runs + excluded.runs,
       findings = findings + excluded.findings`,
  ).run(dimension, key, runsDelta, findingsDelta);
}

function upsertGlobalRow(db: Database, event: AnalyzerAggregateEvent): void {
  db.prepare(
    `INSERT INTO stats_aggregates (dimension, key, runs, findings, runs_with_findings, blocked, first_seen_ms)
     VALUES ('global', '', 1, ?, ?, ?, ?)
     ON CONFLICT (dimension, key) DO UPDATE SET
       runs = runs + excluded.runs,
       findings = findings + excluded.findings,
       runs_with_findings = runs_with_findings + excluded.runs_with_findings,
       blocked = blocked + excluded.blocked,
       first_seen_ms = MIN(first_seen_ms, excluded.first_seen_ms)`,
  ).run(
    event.findingsCount,
    event.findingsCount > 0 ? 1 : 0,
    isSecretsBlocked(event) ? 1 : 0,
    event.timestampMs,
  );
}

export function applyAnalyzerEventToAggregates(db: Database, event: AnalyzerAggregateEvent): void {
  upsertGlobalRow(db, event);
  upsertCounterRow(db, 'analyzer', event.analyzer, 1, event.findingsCount);
  upsertCounterRow(db, 'agent', event.callerAgent, 1, event.findingsCount);
  upsertCounterRow(db, 'trigger', event.runTrigger, 1, 0);
  upsertCounterRow(db, 'caller_command', event.callerCommand, 1, 0);

  for (const [ruleKey, count] of Object.entries(event.ruleCounts ?? {})) {
    upsertCounterRow(db, 'rule', `${event.analyzer}:${ruleKey}`, 0, count);
  }
}
