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

import logger from '@/core/observability/logger.ts';

import { openStatsDb } from './db.ts';

// Same union as AnalysisTelemetryAnalyzer (src/commands/analyze/analysis-completed.ts).
// Not imported from there: src/core never imports from src/commands elsewhere in this
// codebase. Keep the two in sync by hand.
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

// Mirrors appendTelemetryEvent's best-effort local append: a locked/read-only/corrupt-on-retry
// ledger must never fail the analyzer command that triggered the write, so every failure here
// (open or write) is logged and swallowed in favor of the caller's fallback.
function withDb<T>(fn: (db: Database) => T, fallback: T): T {
  let db: Database;
  try {
    db = openStatsDb();
  } catch (error) {
    logger.debug(`stats ledger unavailable: ${(error as Error).message}`);
    return fallback;
  }
  try {
    return fn(db);
  } catch (error) {
    logger.debug(`stats ledger write failed: ${(error as Error).message}`);
    return fallback;
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
  }, undefined);
}

export function upsertRuleMessages(messages: Readonly<Record<string, string>>): void {
  const timestampMs = Date.now();
  withDb((db) => {
    const upsert = db.prepare(
      `INSERT INTO rule_descriptions (rule_key, message, last_seen_ms)
       VALUES (?, ?, ?)
       ON CONFLICT (rule_key) DO UPDATE SET message = excluded.message, last_seen_ms = excluded.last_seen_ms`,
    );
    db.transaction(() => {
      for (const [ruleKey, message] of Object.entries(messages)) {
        upsert.run(ruleKey, message, timestampMs);
      }
    })();
  }, undefined);
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
    // IMMEDIATE takes the write lock up front. A deferred transaction here would open on
    // the SELECT and only try to upgrade to a writer on the first INSERT — which, in WAL
    // mode, fails with SQLITE_BUSY (snapshot conflict) if another connection committed
    // since the read, a case the busy_timeout handler does not cover.
    db.transaction(() => {
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
    }).immediate();
    return notSeenBefore;
  }, new Set(fingerprints));
}
