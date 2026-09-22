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

import { mkdirSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import {
  getCliDir,
  getStatsDir,
  STATS_DB_FILENAME,
  STATS_RETENTION_DAYS,
} from '@/core/config-constants.ts';
import { isCorruptionError, openStatsDb } from '@/core/stats/db.ts';

import { useTempSonarUserHome } from './_helpers.ts';

const DAY_MS = 86_400_000;

function insertRawEvent(db: Database, timestampMs: number): void {
  db.prepare(
    `INSERT INTO stats_events (timestamp_ms, event_class, caller_command, caller_agent, run_trigger, details)
     VALUES (?, 'analyzer', 'analyze', 'claude', 'manual', '{}')`,
  ).run(timestampMs);
}

describe('openStatsDb', () => {
  useTempSonarUserHome('cli-stats-db-test-');

  it('creates a fresh, usable ledger when none exists yet', () => {
    const db = openStatsDb();
    try {
      db.run(
        `INSERT INTO stats_events (timestamp_ms, event_class, caller_command, caller_agent, run_trigger, details)
         VALUES (1, 'analyzer', 'analyze', 'claude', 'manual', '{}')`,
      );
      const count = (
        db.prepare('SELECT COUNT(*) as count FROM stats_events').get() as { count: number }
      ).count;
      expect(count).toBe(1);
    } finally {
      db.close();
    }
  });

  it('quarantines a corrupted ledger file and starts fresh, instead of throwing', async () => {
    const dbPath = join(getStatsDir(), STATS_DB_FILENAME);
    mkdirSync(getStatsDir(), { recursive: true });
    await writeFile(dbPath, 'not a sqlite database');

    const db = openStatsDb();
    db.close();

    const filesInStatsDir = await readdir(getStatsDir());
    expect(filesInStatsDir).toContain(STATS_DB_FILENAME);
    expect(filesInStatsDir.some((name) => name.startsWith(`${STATS_DB_FILENAME}.corrupted-`))).toBe(
      true,
    );
  });

  it('propagates when the stats directory cannot be created, instead of swallowing the error', async () => {
    mkdirSync(join(getCliDir(), 'db'), { recursive: true });
    await writeFile(getStatsDir(), 'a file sitting where the stats directory should be');

    expect(() => openStatsDb()).toThrow();
  });

  it('propagates a transient lock error instead of quarantining a healthy ledger', async () => {
    const dbPath = join(getStatsDir(), STATS_DB_FILENAME);
    mkdirSync(getStatsDir(), { recursive: true });

    const blocker = new Database(dbPath, { create: true });
    blocker.run('BEGIN IMMEDIATE');
    try {
      expect(() => openStatsDb()).toThrow();
    } finally {
      blocker.run('COMMIT');
      blocker.close();
    }

    const filesInStatsDir = await readdir(getStatsDir());
    expect(filesInStatsDir.some((name) => name.includes('.corrupted-'))).toBe(false);
  });
});

describe('openStatsDb: retention purge', () => {
  useTempSonarUserHome('cli-stats-db-purge-test-');

  it('purges rows older than the retention window on the next open, keeps recent ones', () => {
    const setupDb = openStatsDb();
    const oldTimestampMs = Date.now() - (STATS_RETENTION_DAYS + 1) * DAY_MS;
    const recentTimestampMs = Date.now() - DAY_MS;
    insertRawEvent(setupDb, oldTimestampMs);
    insertRawEvent(setupDb, recentTimestampMs);
    setupDb.run(
      `INSERT INTO stats_aggregates (dimension, key, runs, findings)
       VALUES ('global', '', 5, 3)`,
    );
    setupDb.close();

    const db = openStatsDb();
    try {
      const remaining = db
        .prepare('SELECT timestamp_ms FROM stats_events ORDER BY timestamp_ms')
        .all() as Array<{ timestamp_ms: number }>;
      expect(remaining).toEqual([{ timestamp_ms: recentTimestampMs }]);

      const aggregate = db
        .prepare("SELECT runs, findings FROM stats_aggregates WHERE dimension = 'global'")
        .get() as { runs: number; findings: number };
      expect(aggregate).toEqual({ runs: 5, findings: 3 });
    } finally {
      db.close();
    }
  });

  it('keeps a row just inside the retention window', () => {
    const setupDb = openStatsDb();
    // A 1ms margin would be flaky: the close/reopen/migrate round trip below can easily take
    // longer than that before openStatsDb() computes its own cutoff from a fresh Date.now().
    const boundaryTimestampMs = Date.now() - STATS_RETENTION_DAYS * DAY_MS + 60_000;
    insertRawEvent(setupDb, boundaryTimestampMs);
    setupDb.close();

    const db = openStatsDb();
    try {
      const count = (
        db.prepare('SELECT COUNT(*) as count FROM stats_events').get() as { count: number }
      ).count;
      expect(count).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('isCorruptionError', () => {
  it('treats SQLITE_NOTADB and SQLITE_CORRUPT* as corruption', () => {
    expect(isCorruptionError({ code: 'SQLITE_NOTADB' })).toBe(true);
    expect(isCorruptionError({ code: 'SQLITE_CORRUPT' })).toBe(true);
    expect(isCorruptionError({ code: 'SQLITE_CORRUPT_VTAB' })).toBe(true);
  });

  it('does not treat a transient lock/busy error as corruption', () => {
    expect(isCorruptionError({ code: 'SQLITE_BUSY' })).toBe(false);
    expect(isCorruptionError({ code: 'SQLITE_LOCKED' })).toBe(false);
    expect(isCorruptionError(new Error('some unrelated failure'))).toBe(false);
  });
});
