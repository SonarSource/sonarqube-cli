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

import { randomUUID } from 'node:crypto';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import logger from '@/core/observability/logger.ts';

import {
  type AnalysisSession,
  deleteAnalysisLock,
  expireAnalysisState,
  hasRunningAnalysesForSession,
  insertAnalysisLock,
  LOCK_LEASE_SECONDS,
  type LockRow,
  readAnalysisCounter,
  readAnalysisLock,
  readSuccessfulAnalysis,
  recordSuccessfulAnalysis,
  resetAnalysisCounter,
  validateAnalysisLockOwnership,
  withAnalysisState,
  writeAnalysisCounter,
} from './db.ts';
import { isNonEmptyString, isNonNegativeSafeInteger } from './validation.ts';

export type { AnalysisSession, LockRow } from './db.ts';

export interface AcquireAnalysisLockOptions extends AnalysisSession {
  fingerprint: string;
  analysisLimit: number;
}

export type AnalysisLockResult = { lock: LockRow; analysisCount: number } | null;

type AnalysisOutcome = 'continue' | 'stop' | 'failed';

function assertSession(session: AnalysisSession): void {
  if (!isNonEmptyString(session.agent) || !isNonEmptyString(session.session_id)) {
    throw new CommandFailedError('Vortex analysis requires an agent and session ID.');
  }
}

function assertLock(lock: LockRow): void {
  assertSession(lock);
  if (!isNonEmptyString(lock.fingerprint) || !isNonEmptyString(lock.lock_token)) {
    throw new CommandFailedError('Invalid Vortex analysis lock.');
  }
}

/** Returns null when cached, in flight, or at the analysis limit. */
export function acquireAnalysisLock(options: AcquireAnalysisLockOptions): AnalysisLockResult {
  assertSession(options);
  if (
    !isNonEmptyString(options.fingerprint) ||
    !isNonNegativeSafeInteger(options.analysisLimit) ||
    options.analysisLimit < 1
  ) {
    throw new CommandFailedError(
      'Vortex analysis requires a fingerprint and a positive analysis limit.',
    );
  }
  return withAnalysisState((db, now) => {
    expireAnalysisState(db, now);
    const counter = readAnalysisCounter(db, options);
    const successful = readSuccessfulAnalysis(db, options.fingerprint);
    const existingLock = readAnalysisLock(db, options.fingerprint);
    if (
      hasRunningAnalysesForSession(db, options, now) &&
      (!counter || counter.analysis_count < 1)
    ) {
      throw new CommandFailedError('Invalid Vortex analysis counter for active analyses.');
    }
    if (successful || existingLock) return null;
    const count = counter?.analysis_count ?? 0;
    if (count >= options.analysisLimit) return null;
    const lock = {
      agent: options.agent,
      session_id: options.session_id,
      fingerprint: options.fingerprint,
      lock_token: randomUUID(),
      lock_expires_at: now + LOCK_LEASE_SECONDS,
    };
    insertAnalysisLock(db, lock);
    writeAnalysisCounter(db, options, count + 1, now);
    return { lock, analysisCount: count + 1 };
  });
}

export function finishAnalysis(lock: LockRow, outcome: AnalysisOutcome): void {
  assertLock(lock);
  withAnalysisState((db, now) => {
    const counter = validateAnalysisLockOwnership(db, lock, now);
    if (outcome !== 'failed') recordSuccessfulAnalysis(db, lock.fingerprint, now);
    deleteAnalysisLock(db, lock.fingerprint);
    expireAnalysisState(db, now);
    // Preserve the counter while iterating or while another analysis runs in this session.
    const reset = outcome !== 'continue' && !hasRunningAnalysesForSession(db, lock, now);
    writeAnalysisCounter(db, lock, reset ? 0 : counter.analysis_count, now);
  });
}

/**
 * Call when the hook allows stopping without analysis (no project/changes, cached, or limit).
 * Returns false if another analysis is running or resetting fails.
 */
export function resetAnalysisCounterIfIdle(session: AnalysisSession): boolean {
  try {
    assertSession(session);
    return withAnalysisState((db, now) => {
      expireAnalysisState(db, now);
      const counter = readAnalysisCounter(db, session);
      if (hasRunningAnalysesForSession(db, session, now)) {
        if (!counter || counter.analysis_count < 1) {
          throw new CommandFailedError('Invalid Vortex analysis counter for active analyses.');
        }
        return false;
      }
      resetAnalysisCounter(db, session, now);
      return true;
    });
  } catch (error) {
    logger.debug('Vortex analysis counter reset failed', error);
    return false;
  }
}
