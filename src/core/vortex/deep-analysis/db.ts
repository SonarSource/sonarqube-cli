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
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { getVortexAnalysisDbPath } from '@/core/config-constants.ts';

import { applyAnalysisMigrations } from './migrations.ts';
import { isNonEmptyString, isNonNegativeSafeInteger } from './validation.ts';

export const COUNTER_RETENTION_SECONDS = 60 * 60;
export const SUCCESSFUL_ANALYSIS_RETENTION_SECONDS = 60 * 60;
export const LOCK_LEASE_SECONDS = 2 * 60;

export interface AnalysisSession {
  agent: string;
  session_id: string;
}

export interface CounterRow {
  analysis_count: number;
  updated_at: number;
}

export interface SuccessfulAnalysisRow {
  fingerprint: string;
  analyzed_at: number;
}

export interface LockRow {
  fingerprint: string;
  lock_token: string;
  lock_expires_at: number;
  agent: string;
  session_id: string;
}

function validateLock(row: LockRow | null): LockRow | null {
  if (!row) return null;
  if (
    !isNonEmptyString(row.fingerprint) ||
    !isNonEmptyString(row.lock_token) ||
    !isNonNegativeSafeInteger(row.lock_expires_at) ||
    !isNonEmptyString(row.agent) ||
    !isNonEmptyString(row.session_id)
  ) {
    throw new CommandFailedError('Invalid Vortex analysis lock.');
  }
  return row;
}

// Open and initialize the Vortex analysis database.
export function openAnalysisDb(): Database {
  let db: Database | undefined;
  try {
    const dbPath = getVortexAnalysisDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new Database(dbPath, { create: true, strict: true });
    // Wait up to one second for SQLite locks.
    db.run('PRAGMA busy_timeout = 1000');
    // WAL allows readers alongside a writer.
    db.run('PRAGMA journal_mode = WAL');
    applyAnalysisMigrations(db);
    return db;
  } catch (cause) {
    db?.close();
    // Storage failures must never become an empty retry budget.
    throw new CommandFailedError('Could not open Vortex analysis state.', { cause });
  }
}

// Read-then-write operations serialize across CLI processes and always close their handle.
export function withAnalysisState<T>(operation: (db: Database, now: number) => T): T {
  const db = openAnalysisDb();
  try {
    try {
      return db.transaction(() => operation(db, Math.floor(Date.now() / 1000))).immediate();
    } finally {
      db.close();
    }
  } catch (cause) {
    throw new CommandFailedError('Could not update Vortex analysis state.', { cause });
  }
}

// Call inside an immediate transaction, preserving counters owned by live locks.
export function expireAnalysisState(db: Database, now: number): void {
  db.prepare<unknown, [number]>('DELETE FROM vortex_analysis_locks WHERE lock_expires_at <= ?').run(
    now,
  );
  db.prepare<unknown, [number]>(
    'DELETE FROM vortex_successful_analyses WHERE analyzed_at <= ?',
  ).run(now - SUCCESSFUL_ANALYSIS_RETENTION_SECONDS);
  db.prepare<unknown, [number]>(
    `DELETE FROM vortex_analysis_counters AS counters WHERE updated_at <= ?
    AND NOT EXISTS (SELECT 1 FROM vortex_analysis_locks AS locks
      WHERE locks.agent = counters.agent AND locks.session_id = counters.session_id)`,
  ).run(now - COUNTER_RETENTION_SECONDS);
}

// Return the session counter or null, rejecting invalid persisted values.
export function readAnalysisCounter(db: Database, session: AnalysisSession): CounterRow | null {
  const row = db
    .prepare<CounterRow, [string, string]>(
      'SELECT analysis_count, updated_at FROM vortex_analysis_counters WHERE agent = ? AND session_id = ?',
    )
    .get(session.agent, session.session_id);
  if (
    row &&
    (!isNonNegativeSafeInteger(row.analysis_count) || !isNonNegativeSafeInteger(row.updated_at))
  ) {
    throw new CommandFailedError('Invalid Vortex analysis counter.');
  }
  return row;
}

// Read the last successful analysis for a fingerprint.
export function readSuccessfulAnalysis(
  db: Database,
  fingerprint: string,
): SuccessfulAnalysisRow | null {
  const row = db
    .prepare<SuccessfulAnalysisRow, [string]>(
      'SELECT fingerprint, analyzed_at FROM vortex_successful_analyses WHERE fingerprint = ?',
    )
    .get(fingerprint);
  if (row && (!isNonEmptyString(row.fingerprint) || !isNonNegativeSafeInteger(row.analyzed_at))) {
    throw new CommandFailedError('Invalid successful Vortex analysis.');
  }
  return row;
}

// Return the fingerprint lock, or null if none exists.
export function readAnalysisLock(db: Database, fingerprint: string): LockRow | null {
  return validateLock(
    db
      .prepare<LockRow, [string]>(
        'SELECT fingerprint, lock_token, lock_expires_at, agent, session_id FROM vortex_analysis_locks WHERE fingerprint = ?',
      )
      .get(fingerprint),
  );
}

// Check whether the session has unexpired locks.
export function hasRunningAnalysesForSession(
  db: Database,
  session: AnalysisSession,
  now: number,
): boolean {
  return (
    db
      .prepare<{ active: number }, [string, string, number]>(
        'SELECT EXISTS(SELECT 1 FROM vortex_analysis_locks WHERE agent = ? AND session_id = ? AND lock_expires_at > ?) AS active',
      )
      .get(session.agent, session.session_id, now)?.active === 1
  );
}
// Insert a fingerprint lock, rejecting duplicates.
export function insertAnalysisLock(db: Database, lock: LockRow): void {
  db.prepare<unknown, [string, string, number, string, string]>(
    `INSERT INTO vortex_analysis_locks
    (fingerprint, lock_token, lock_expires_at, agent, session_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(lock.fingerprint, lock.lock_token, lock.lock_expires_at, lock.agent, lock.session_id);
}

// Upsert the session counter and its update timestamp.
export function writeAnalysisCounter(
  db: Database,
  session: AnalysisSession,
  count: number,
  now: number,
): void {
  db.prepare<unknown, [string, string, number, number]>(
    `INSERT INTO vortex_analysis_counters (agent, session_id, analysis_count, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (agent, session_id)
    DO UPDATE SET analysis_count = excluded.analysis_count, updated_at = excluded.updated_at`,
  ).run(session.agent, session.session_id, count, now);
}

// Reset an existing counter without creating one.
export function resetAnalysisCounter(db: Database, session: AnalysisSession, now: number): void {
  db.prepare<unknown, [number, string, string]>(
    `UPDATE vortex_analysis_counters SET analysis_count = 0, updated_at = ?
    WHERE agent = ? AND session_id = ?`,
  ).run(now, session.agent, session.session_id);
}

/** Reject completion if ownership changed or the two-minute lease expired; return the session counter. */
export function validateAnalysisLockOwnership(
  db: Database,
  lock: LockRow,
  now: number,
): CounterRow {
  const row = readAnalysisLock(db, lock.fingerprint);
  const counter = readAnalysisCounter(db, lock);
  if (
    row?.lock_token !== lock.lock_token ||
    row.agent !== lock.agent ||
    row.session_id !== lock.session_id ||
    row.lock_expires_at <= now ||
    !counter ||
    counter.analysis_count < 1
  ) {
    throw new CommandFailedError('Vortex analysis lock is no longer owned by this run.');
  }
  return counter;
}

// Record the last successful analysis time for a fingerprint.
export function recordSuccessfulAnalysis(db: Database, fingerprint: string, now: number): void {
  db.prepare<unknown, [string, number]>(
    `INSERT INTO vortex_successful_analyses (fingerprint, analyzed_at) VALUES (?, ?)
      ON CONFLICT (fingerprint) DO UPDATE SET analyzed_at = excluded.analyzed_at`,
  ).run(fingerprint, now);
}

// Delete the fingerprint's lock without changing successful analyses.
export function deleteAnalysisLock(db: Database, fingerprint: string): void {
  db.prepare<unknown, [string]>('DELETE FROM vortex_analysis_locks WHERE fingerprint = ?').run(
    fingerprint,
  );
}
