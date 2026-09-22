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

import { applyAnalyzerEventToAggregates } from './aggregates.ts';

export interface StatsMigration {
  version: number;
  up: (db: Database) => void;
}

interface StoredAnalyzerEventRow {
  timestamp_ms: number;
  caller_command: string;
  exit_code: number | null;
  caller_agent: string;
  run_trigger: 'hooks' | 'manual';
  details: string;
}

function backfillAggregatesFromExistingEvents(db: Database): void {
  const rows = db
    .prepare<StoredAnalyzerEventRow, []>(
      `SELECT timestamp_ms, caller_command, exit_code, caller_agent, run_trigger, details
       FROM stats_events WHERE event_class = 'analyzer'`,
    )
    .all();

  for (const row of rows) {
    const details = JSON.parse(row.details) as {
      analyzer: string;
      findingsCount: number;
      ruleCounts?: Record<string, number>;
    };
    applyAnalyzerEventToAggregates(db, {
      timestampMs: row.timestamp_ms,
      callerCommand: row.caller_command,
      exitCode: row.exit_code,
      callerAgent: row.caller_agent,
      runTrigger: row.run_trigger,
      analyzer: details.analyzer,
      findingsCount: details.findingsCount,
      ruleCounts: details.ruleCounts,
    });
  }
}

export const STATS_MIGRATIONS: readonly StatsMigration[] = [
  {
    version: 1,
    up: (db) => {
      db.run(`
        CREATE TABLE stats_events (
          id INTEGER PRIMARY KEY,
          timestamp_ms INTEGER NOT NULL,
          event_class TEXT NOT NULL,
          caller_command TEXT NOT NULL,
          exit_code INTEGER,
          caller_agent TEXT NOT NULL,
          run_trigger TEXT NOT NULL,
          duration_ms INTEGER,
          details TEXT NOT NULL
        );
        CREATE INDEX idx_stats_events_timestamp ON stats_events (timestamp_ms);

        CREATE TABLE rule_descriptions (
          rule_key TEXT PRIMARY KEY,
          message TEXT NOT NULL,
          last_seen_ms INTEGER NOT NULL
        );

        CREATE TABLE seen_fingerprints (
          scope TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          first_seen_ms INTEGER NOT NULL,
          last_seen_ms INTEGER NOT NULL,
          PRIMARY KEY (scope, fingerprint)
        );
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.run(`
        CREATE TABLE stats_aggregates (
          dimension TEXT NOT NULL,
          key TEXT NOT NULL,
          runs INTEGER NOT NULL DEFAULT 0,
          findings INTEGER NOT NULL DEFAULT 0,
          runs_with_findings INTEGER NOT NULL DEFAULT 0,
          blocked INTEGER NOT NULL DEFAULT 0,
          first_seen_ms INTEGER,
          PRIMARY KEY (dimension, key)
        );
      `);
      backfillAggregatesFromExistingEvents(db);
    },
  },
];

export function applyMigrations(db: Database, migrations: readonly StatsMigration[]): void {
  // .immediate(): avoids two racing processes reading the same stale user_version.
  db.transaction(() => {
    const currentVersion =
      db.prepare<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;

    const pending = migrations
      .filter((migration) => migration.version > currentVersion)
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      migration.up(db);
      db.run(`PRAGMA user_version = ${migration.version}`);
    }
  }).immediate();
}

export function applyStatsMigrations(db: Database): void {
  applyMigrations(db, STATS_MIGRATIONS);
}
