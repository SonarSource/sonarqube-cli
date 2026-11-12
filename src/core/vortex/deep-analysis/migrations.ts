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

import { CommandFailedError } from '@/core/commands/command-error.ts';

interface AnalysisMigration {
  version: number;
  up: (db: Database) => void;
}

export const ANALYSIS_MIGRATIONS: readonly AnalysisMigration[] = [
  {
    version: 1,
    up: (db) => {
      db.run(`CREATE TABLE vortex_analysis_counters (
        agent TEXT NOT NULL CHECK (length(agent) > 0),
        session_id TEXT NOT NULL CHECK (length(session_id) > 0),
        analysis_count INTEGER NOT NULL CHECK (analysis_count >= 0 AND analysis_count <= 9007199254740991),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        PRIMARY KEY (agent, session_id)
      ) STRICT`);
      db.run(`CREATE TABLE vortex_successful_analyses (
        fingerprint TEXT PRIMARY KEY NOT NULL CHECK (length(fingerprint) > 0),
        analyzed_at INTEGER NOT NULL CHECK (analyzed_at >= 0)
      ) STRICT`);
      db.run(`CREATE TABLE vortex_analysis_locks (
        fingerprint TEXT PRIMARY KEY NOT NULL CHECK (length(fingerprint) > 0),
        lock_token TEXT NOT NULL CHECK (length(lock_token) > 0),
        lock_expires_at INTEGER NOT NULL CHECK (lock_expires_at >= 0),
        agent TEXT NOT NULL CHECK (length(agent) > 0),
        session_id TEXT NOT NULL CHECK (length(session_id) > 0)
      ) STRICT`);
    },
  },
];

function validateAnalysisSchema(db: Database): void {
  const counterColumns = db
    .prepare<{ name: string; type: string; notnull: number; pk: number }, []>(
      'PRAGMA table_info(vortex_analysis_counters)',
    )
    .all();
  const successfulAnalysisColumns = db
    .prepare<{ name: string; type: string; notnull: number; pk: number }, []>(
      'PRAGMA table_info(vortex_successful_analyses)',
    )
    .all();
  const lockColumns = db
    .prepare<{ name: string; type: string; notnull: number; pk: number }, []>(
      'PRAGMA table_info(vortex_analysis_locks)',
    )
    .all();
  const requiredCounter = [
    { name: 'agent', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'session_id', type: 'TEXT', notnull: 1, pk: 2 },
    { name: 'analysis_count', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ];
  const requiredSuccessfulAnalysis = [
    { name: 'fingerprint', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'analyzed_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ];
  const requiredLock = [
    { name: 'fingerprint', type: 'TEXT', notnull: 1, pk: 1 },
    { name: 'lock_token', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'lock_expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'agent', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'session_id', type: 'TEXT', notnull: 1, pk: 0 },
  ];
  const columnsMatch = (actual: typeof counterColumns, required: typeof counterColumns) =>
    required.every((expected) =>
      actual.some(
        (column) =>
          column.name === expected.name &&
          column.type.toUpperCase() === expected.type &&
          column.notnull === expected.notnull &&
          column.pk === expected.pk,
      ),
    );
  if (
    !columnsMatch(counterColumns, requiredCounter) ||
    !columnsMatch(successfulAnalysisColumns, requiredSuccessfulAnalysis) ||
    !columnsMatch(lockColumns, requiredLock)
  ) {
    throw new CommandFailedError('Invalid Vortex analysis state schema.');
  }
}

// Missing structures in an existing schema are errors, never a fresh retry budget.
export function applyAnalysisMigrations(db: Database): void {
  db.transaction(() => {
    const version = db
      .prepare<{ user_version: number }, []>('PRAGMA user_version')
      .get()?.user_version;
    const latestVersion = ANALYSIS_MIGRATIONS.at(-1)?.version;
    if (
      version === undefined ||
      latestVersion === undefined ||
      version < 0 ||
      version > latestVersion
    ) {
      throw new CommandFailedError('Unsupported Vortex analysis state schema version.');
    }
    if (
      version === 0 &&
      db
        .prepare<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        )
        .get()?.count !== 0
    ) {
      throw new CommandFailedError('Invalid unversioned Vortex analysis state.');
    }
    for (const migration of ANALYSIS_MIGRATIONS.filter((entry) => entry.version > version)) {
      migration.up(db);
      db.run(`PRAGMA user_version = ${migration.version}`);
    }
    validateAnalysisSchema(db);
  }).immediate();
}
