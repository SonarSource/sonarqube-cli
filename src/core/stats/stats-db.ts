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

import { getStatsDir, STATS_DB_FILENAME } from '@/core/config-constants.ts';
import logger from '@/core/observability/logger.ts';

import { applyStatsMigrations } from './stats-migrations.ts';

function openAndMigrate(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 200');
  applyStatsMigrations(db);
  return db;
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
    logger.debug(
      `openStatsDb: ledger unreadable, quarantining and starting fresh: ${(error as Error).message}`,
    );
    quarantineLedgerFiles(dbPath);
    return openAndMigrate(dbPath);
  }
}
