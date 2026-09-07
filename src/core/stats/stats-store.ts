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

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { detectCallerAgent } from '@/core/host/environment/agent-detector.ts';
import logger from '@/core/observability/logger.ts';
import { tryLoadState } from '@/core/state/state-manager.ts';
import { isTelemetryEnabled } from '@/core/telemetry/enabled.ts';

import { getStatsDir, STATS_DB_FILENAME } from '../config-constants.ts';

const SCHEMA_VERSION = 1;

function readSchemaVersion(dbPath: string): number {
  const db = new Database(dbPath);
  try {
    return db.prepare<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  } finally {
    db.close();
  }
}

export function openStatsDb(): Database {
  mkdirSync(getStatsDir(), { recursive: true });
  const dbPath = join(getStatsDir(), STATS_DB_FILENAME);

  if (existsSync(dbPath) && readSchemaVersion(dbPath) !== SCHEMA_VERSION) {
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }

  const db = new Database(dbPath, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 200');
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  db.run(`
    CREATE TABLE IF NOT EXISTS stats_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp_ms INTEGER NOT NULL,
      event_class TEXT NOT NULL,
      caller_command TEXT NOT NULL,
      exit_code INTEGER,
      caller_agent TEXT NOT NULL,
      run_trigger TEXT NOT NULL,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_stats_events_timestamp ON stats_events (timestamp_ms);

    CREATE TABLE IF NOT EXISTS analyzer_event_details (
      event_id INTEGER PRIMARY KEY REFERENCES stats_events (id),
      analyzer TEXT NOT NULL,
      findings_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analysis_event_rule_counts (
      event_id INTEGER NOT NULL REFERENCES stats_events (id),
      rule_key TEXT NOT NULL,
      count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rule_counts_event ON analysis_event_rule_counts (event_id);

    CREATE TABLE IF NOT EXISTS rule_descriptions (
      rule_key TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      last_seen_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seen_fingerprints (
      scope TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      first_seen_ms INTEGER NOT NULL,
      last_seen_ms INTEGER NOT NULL,
      PRIMARY KEY (scope, fingerprint)
    );
  `);
  return db;
}

export type StatsAnalyzer = 'sonar-secrets' | 'sqaa' | 'sca-scanner-cli';

export type StatsTrigger = 'hooks' | 'manual';

const MANUAL_CALLER_COMMANDS: ReadonlySet<string> = new Set([
  'analyze',
  'analyze secrets',
  'analyze dependency-risks',
  'analyze agentic',
  'verify',
]);

function resolveTrigger(callerCommand: string): StatsTrigger {
  return MANUAL_CALLER_COMMANDS.has(callerCommand) ? 'manual' : 'hooks';
}

export interface RecordAnalysisStatsInput {
  analyzer: StatsAnalyzer;
  callerCommand: string;
  exitCode: number | null;
  durationMs?: number | null;
  findingsCount: number;
  ruleCounts?: Record<string, number>;
  ruleMessages?: Record<string, string>;
}

function upsertRuleMessages(
  db: Database,
  ruleMessages: Readonly<Record<string, string>>,
  timestampMs: number,
): void {
  const upsertMessage = db.prepare(
    `INSERT INTO rule_descriptions (rule_key, message, last_seen_ms)
     VALUES (?, ?, ?)
     ON CONFLICT (rule_key) DO UPDATE SET message = excluded.message, last_seen_ms = excluded.last_seen_ms`,
  );
  for (const [ruleKey, message] of Object.entries(ruleMessages)) {
    upsertMessage.run(ruleKey, message, timestampMs);
  }
}

function persistAnalysisEvent(db: Database, input: RecordAnalysisStatsInput): void {
  const timestampMs = Date.now();
  const { findingsCount, ruleCounts, ruleMessages } = input;

  const { lastInsertRowid: eventId } = db
    .prepare(
      `INSERT INTO stats_events
         (timestamp_ms, event_class, caller_command, exit_code, caller_agent, run_trigger, duration_ms)
       VALUES (?, 'analyzer', ?, ?, ?, ?, ?)`,
    )
    .run(
      timestampMs,
      input.callerCommand,
      input.exitCode,
      detectCallerAgent() ?? 'unidentified',
      resolveTrigger(input.callerCommand),
      input.durationMs ?? null,
    );

  db.prepare(
    'INSERT INTO analyzer_event_details (event_id, analyzer, findings_count) VALUES (?, ?, ?)',
  ).run(eventId, input.analyzer, findingsCount);

  if (ruleCounts) {
    const insertRule = db.prepare(
      'INSERT INTO analysis_event_rule_counts (event_id, rule_key, count) VALUES (?, ?, ?)',
    );
    for (const [ruleKey, count] of Object.entries(ruleCounts)) {
      insertRule.run(eventId, ruleKey, count);
    }
  }

  if (ruleMessages) {
    upsertRuleMessages(db, ruleMessages, timestampMs);
  }
}

export function recordAnalysisStats(input: RecordAnalysisStatsInput): void {
  try {
    const state = tryLoadState();
    if (!state || !isTelemetryEnabled(state)) return;

    const db = openStatsDb();
    try {
      persistAnalysisEvent(db, input);
    } finally {
      db.close();
    }
  } catch (err) {
    logger.debug(`recordAnalysisStats: failed to record: ${(err as Error).message}`);
  }
}

function dedupeAgainstSeenInDb(
  db: Database,
  scope: string,
  fingerprints: readonly string[],
  timestampMs: number,
): Set<string> {
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
    if (dedupedInThisCall.has(fingerprint)) continue;
    dedupedInThisCall.add(fingerprint);

    if (!selectSeen.get(scope, fingerprint)) {
      notSeenBefore.add(fingerprint);
    }
    upsertSeen.run(scope, fingerprint, timestampMs, timestampMs);
  }
  return notSeenBefore;
}

export function dedupeAgainstSeen(scope: string, fingerprints: readonly string[]): Set<string> {
  const selfDeduped = new Set(fingerprints);
  try {
    const state = tryLoadState();
    if (!state || !isTelemetryEnabled(state)) return selfDeduped;

    const db = openStatsDb();
    try {
      return dedupeAgainstSeenInDb(db, scope, [...selfDeduped], Date.now());
    } finally {
      db.close();
    }
  } catch (err) {
    logger.debug(
      `dedupeAgainstSeen: failed, returning self-deduped only: ${(err as Error).message}`,
    );
    return selfDeduped;
  }
}
