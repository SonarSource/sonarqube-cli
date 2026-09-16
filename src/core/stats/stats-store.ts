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

import { openStatsDb } from './stats-db.ts';

export type StatsAnalyzer = 'sonar-secrets' | 'sqaa' | 'sca-scanner-cli';

export type StatsTrigger = 'hooks' | 'manual';

export type StatsEventDetails = {
  eventClass: 'analyzer';
  analyzer: StatsAnalyzer;
  findingsCount: number;
  ruleCounts?: Record<string, number>;
};

export interface StatsEventEnvelope {
  callerCommand: string;
  exitCode: number | null;
  callerAgent: string;
  runTrigger: StatsTrigger;
  durationMs?: number | null;
}

function withDb<T>(fn: (db: Database) => T): T {
  const db = openStatsDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function recordStatsEvent(envelope: StatsEventEnvelope, details: StatsEventDetails): void {
  withDb((db) => {
    db.prepare(
      `INSERT INTO stats_events
         (timestamp_ms, event_class, caller_command, exit_code, caller_agent, run_trigger, duration_ms, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Date.now(),
      details.eventClass,
      envelope.callerCommand,
      envelope.exitCode,
      envelope.callerAgent,
      envelope.runTrigger,
      envelope.durationMs ?? null,
      JSON.stringify(details),
    );
  });
}

export function upsertRuleMessages(messages: Readonly<Record<string, string>>): void {
  const timestampMs = Date.now();
  withDb((db) => {
    const upsert = db.prepare(
      `INSERT INTO rule_descriptions (rule_key, message, last_seen_ms)
       VALUES (?, ?, ?)
       ON CONFLICT (rule_key) DO UPDATE SET message = excluded.message, last_seen_ms = excluded.last_seen_ms`,
    );
    for (const [ruleKey, message] of Object.entries(messages)) {
      upsert.run(ruleKey, message, timestampMs);
    }
  });
}

export function dedupeAgainstSeen(scope: string, fingerprints: readonly string[]): Set<string> {
  const timestampMs = Date.now();
  return withDb((db) => {
    const selectSeen = db.prepare<{ 1: number }, [string, string]>(
      'SELECT 1 FROM seen_fingerprints WHERE scope = ? AND fingerprint = ?',
    );
    const upsertSeen = db.prepare(
      `INSERT INTO seen_fingerprints (scope, fingerprint, first_seen_ms, last_seen_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, fingerprint) DO UPDATE SET last_seen_ms = excluded.last_seen_ms`,
    );

    const notSeenBefore = new Set<string>();
    const dedupedInThisCall = new Set<string>();
    for (const fingerprint of fingerprints) {
      if (dedupedInThisCall.has(fingerprint)) {
        continue;
      }
      dedupedInThisCall.add(fingerprint);

      if (!selectSeen.get(scope, fingerprint)) {
        notSeenBefore.add(fingerprint);
      }
      upsertSeen.run(scope, fingerprint, timestampMs, timestampMs);
    }
    return notSeenBefore;
  });
}
