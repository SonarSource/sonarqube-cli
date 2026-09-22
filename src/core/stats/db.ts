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

import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { getStatsDir, STATS_DB_FILENAME, STATS_RETENTION_DAYS } from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';

import { applyStatsMigrations } from './migrations.ts';

const CORRUPTION_ERROR_CODE_PREFIXES = ['SQLITE_NOTADB', 'SQLITE_CORRUPT'];

const DAY_MS = 86_400_000;

// Their contribution already lives in stats_aggregates (updated at write time, per row) —
// deleting raw rows here needs no recomputation.
function purgeOldStatsEvents(db: Database): void {
  const cutoffMs = Date.now() - STATS_RETENTION_DAYS * DAY_MS;
  db.prepare('DELETE FROM stats_events WHERE timestamp_ms < ?').run(cutoffMs);
}

export function isCorruptionError(error: unknown): boolean {
  const code = (error as { code?: string }).code ?? '';
  return CORRUPTION_ERROR_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

function openAndMigrate(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  try {
    // Must precede journal_mode=WAL: the WAL conversion's brief lock isn't covered otherwise.
    db.run('PRAGMA busy_timeout = 5000');
    db.run('PRAGMA journal_mode = WAL');
    applyStatsMigrations(db);
    purgeOldStatsEvents(db);
    return db;
  } catch (error) {
    // Windows can't rename/delete a file with an open handle — release ours before the
    // caller tries to quarantine it, or the retry will just fail on the same locked file.
    db.close();
    throw error;
  }
}

function quarantineLedgerFiles(dbPath: string): void {
  const suffix = `corrupted-${Date.now()}`;
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      renameSync(path, `${path}.${suffix}`);
    } catch {
      // Best-effort: nothing to quarantine, or another process already moved it.
    }
  }
}

export function openStatsDb(): Database {
  mkdirSync(getStatsDir(), { recursive: true });
  const dbPath = join(getStatsDir(), STATS_DB_FILENAME);

  try {
    return openAndMigrate(dbPath);
  } catch (error) {
    if (!isCorruptionError(error)) {
      throw error;
    }
    logger.debug(
      `openStatsDb: ledger corrupted, quarantining and starting fresh: ${(error as Error).message}`,
    );
    quarantineLedgerFiles(dbPath);
    return openAndMigrate(dbPath);
  }
}
