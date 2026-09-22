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

// Mirrors EXIT_CODE_SECRETS_FOUND in src/commands/analyze/secrets.ts — not imported, since
// src/core never imports src/commands.
const SECRETS_BLOCKED_EXIT_CODE = 51;

// Hand-synced against SECRETS_CALLER_COMMANDS in src/commands/analyze/secrets-analysis-telemetry.ts,
// for the same import-direction reason.
const SECRETS_BLOCKED_CALLER_COMMANDS: ReadonlySet<string> = new Set([
  'git-pre-commit',
  'git-pre-push',
  'agent-prompt-submit',
  'cursor-prompt-submit',
  'claude-pre-tool-use',
  'copilot-pre-tool-use',
  'antigravity-pre-tool-use',
  'cursor-pre-file-read',
  'cursor-pre-tool-use',
]);

/** Input for {@link applyAnalyzerEventToAggregates}; a self-contained shape to avoid an import cycle. */
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
    event.exitCode === SECRETS_BLOCKED_EXIT_CODE &&
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

/** Folds one `analyzer`-class event into the all-time counters, so it survives purging the raw row later. */
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
