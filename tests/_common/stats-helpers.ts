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

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import type { StatsEventDetails } from '@/core/stats/store.ts';

const IS_WINDOWS = process.platform === 'win32';

export function statsDbPath(sonarUserHome: string): string {
  return join(sonarUserHome, 'sonarqube-cli', 'db', 'stats', 'stats.db');
}

/**
 * Removes a test's temp `SONAR_USER_HOME`, tolerating Windows holding the just-closed stats
 * db's WAL/SHM handles past our retries — best-effort, the OS reclaims the temp dir regardless.
 */
export async function removeTestSonarUserHome(sonarUserHome: string): Promise<void> {
  await rm(sonarUserHome, {
    recursive: true,
    force: true,
    maxRetries: IS_WINDOWS ? 15 : 5,
    retryDelay: IS_WINDOWS ? 200 : 100,
  }).catch(() => {});
}

export interface StoredStatsEvent {
  timestamp_ms: number;
  event_class: string;
  caller_command: string;
  exit_code: number | null;
  caller_agent: string;
  run_trigger: string;
  duration_ms: number | null;
  details: string;
}

export type StoredAnalyzerStatsEvent = StoredStatsEvent & {
  parsedDetails: StatsEventDetails;
};

function openReadonly(sonarUserHome: string): Database | null {
  const dbPath = statsDbPath(sonarUserHome);
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

/** Reads every row from `stats_events`, with `details` parsed for analyzer events. */
export function readStatsEvents(sonarUserHome: string): StoredAnalyzerStatsEvent[] {
  const db = openReadonly(sonarUserHome);
  if (!db) return [];
  try {
    const rows = db.prepare('SELECT * FROM stats_events ORDER BY id').all() as StoredStatsEvent[];
    return rows.map((row) => ({ ...row, parsedDetails: JSON.parse(row.details) }));
  } finally {
    db.close();
  }
}

export function readStatsRuleDescriptions(
  sonarUserHome: string,
): Array<{ rule_key: string; message: string }> {
  const db = openReadonly(sonarUserHome);
  if (!db) return [];
  try {
    return db.prepare('SELECT rule_key, message FROM rule_descriptions').all() as never;
  } finally {
    db.close();
  }
}

export interface StoredStatsAggregate {
  runs: number;
  findings: number;
  runs_with_findings: number;
  blocked: number;
  first_seen_ms: number | null;
}

export function readStatsAggregateFromDb(
  db: Database,
  dimension: string,
  key: string,
): StoredStatsAggregate | null {
  return db
    .prepare<StoredStatsAggregate, [string, string]>(
      'SELECT runs, findings, runs_with_findings, blocked, first_seen_ms FROM stats_aggregates WHERE dimension = ? AND key = ?',
    )
    .get(dimension, key);
}

export function readStatsAggregate(
  sonarUserHome: string,
  dimension: string,
  key: string,
): StoredStatsAggregate | null {
  const db = openReadonly(sonarUserHome);
  if (!db) return null;
  try {
    return readStatsAggregateFromDb(db, dimension, key);
  } finally {
    db.close();
  }
}

/** Rewrites every `stats_events` row's timestamp, to simulate history older than the ledger's actual age. */
export function backdateStatsEvents(sonarUserHome: string, timestampMs: number): void {
  const db = new Database(statsDbPath(sonarUserHome));
  try {
    db.prepare('UPDATE stats_events SET timestamp_ms = ?').run(timestampMs);
  } finally {
    db.close();
  }
}
