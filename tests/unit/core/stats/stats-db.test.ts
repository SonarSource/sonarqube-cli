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
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import {
  ENV_SONAR_USER_HOME,
  getCliDir,
  getStatsDir,
  STATS_DB_FILENAME,
} from '@/core/config-constants.ts';
import { isCorruptionError, openStatsDb } from '@/core/stats/stats-db.ts';

const IS_WINDOWS = process.platform === 'win32';

async function withTempSonarUserHome<T>(fn: () => T | Promise<T>): Promise<T> {
  const testSonarUserHome = await mkdtemp(join(tmpdir(), 'cli-stats-db-test-'));
  const previous = process.env[ENV_SONAR_USER_HOME];
  process.env[ENV_SONAR_USER_HOME] = testSonarUserHome;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_SONAR_USER_HOME];
    } else {
      process.env[ENV_SONAR_USER_HOME] = previous;
    }
    // Windows can hold the just-closed db's WAL/SHM handles past our retries; best-effort
    // only — the OS reclaims the temp dir regardless, same as tests/integration/harness/index.ts.
    await rm(testSonarUserHome, {
      recursive: true,
      force: true,
      maxRetries: IS_WINDOWS ? 15 : 5,
      retryDelay: IS_WINDOWS ? 200 : 100,
    }).catch(() => {});
  }
}

describe('openStatsDb', () => {
  it('creates a fresh, usable ledger when none exists yet', async () => {
    await withTempSonarUserHome(() => {
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
  });

  it('quarantines a corrupted ledger file and starts fresh, instead of throwing', async () => {
    await withTempSonarUserHome(async () => {
      const dbPath = join(getStatsDir(), STATS_DB_FILENAME);
      mkdirSync(getStatsDir(), { recursive: true });
      await writeFile(dbPath, 'not a sqlite database');

      const db = openStatsDb();
      db.close();

      const filesInStatsDir = await readdir(getStatsDir());
      expect(filesInStatsDir).toContain(STATS_DB_FILENAME);
      expect(
        filesInStatsDir.some((name) => name.startsWith(`${STATS_DB_FILENAME}.corrupted-`)),
      ).toBe(true);
    });
  });

  it('propagates when the stats directory cannot be created, instead of swallowing the error', async () => {
    await withTempSonarUserHome(async () => {
      mkdirSync(join(getCliDir(), 'db'), { recursive: true });
      await writeFile(getStatsDir(), 'a file sitting where the stats directory should be');

      expect(() => openStatsDb()).toThrow();
    });
  });

  it('propagates a transient lock error instead of quarantining a healthy ledger', async () => {
    await withTempSonarUserHome(async () => {
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
