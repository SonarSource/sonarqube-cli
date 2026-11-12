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

import * as fs from 'node:fs';

import * as sqlite from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import logger from '@/core/observability/logger.ts';
import * as db from '@/core/vortex/deep-analysis/db.ts';
import {
  acquireAnalysisLock,
  finishAnalysis,
  resetAnalysisCounterIfIdle,
} from '@/core/vortex/deep-analysis/state.ts';

const NOW = 1000;
const SESSION = { agent: 'claude', session_id: 'session' };
const LOCK: db.LockRow = {
  ...SESSION,
  fingerprint: 'fingerprint',
  lock_token: 'owner',
  lock_expires_at: NOW + 120,
};
const FAKE_DB = {} as sqlite.Database;
const constructors = sqlite as unknown as {
  Database: (...args: ConstructorParameters<typeof sqlite.Database>) => sqlite.Database;
};

function stubStateDb() {
  return {
    debug: spyOn(logger, 'debug').mockImplementation(() => undefined),
    mkdir: spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('Unexpected filesystem access');
    }),
    construct: spyOn(constructors, 'Database').mockImplementation(() => {
      throw new Error('Unexpected real database access');
    }),
    state: spyOn(db, 'withAnalysisState').mockImplementation(
      <T>(operation: (database: sqlite.Database, now: number) => T): T => operation(FAKE_DB, NOW),
    ),
    expire: spyOn(db, 'expireAnalysisState').mockImplementation(() => undefined),
    counter: spyOn(db, 'readAnalysisCounter').mockReturnValue(null),
    successful: spyOn(db, 'readSuccessfulAnalysis').mockReturnValue(null),
    lock: spyOn(db, 'readAnalysisLock').mockReturnValue(null),
    running: spyOn(db, 'hasRunningAnalysesForSession').mockReturnValue(false),
    insert: spyOn(db, 'insertAnalysisLock').mockImplementation(() => undefined),
    write: spyOn(db, 'writeAnalysisCounter').mockImplementation(() => undefined),
    owner: spyOn(db, 'validateAnalysisLockOwnership').mockReturnValue({
      analysis_count: 2,
      updated_at: NOW,
    }),
    record: spyOn(db, 'recordSuccessfulAnalysis').mockImplementation(() => undefined),
    release: spyOn(db, 'deleteAnalysisLock').mockImplementation(() => undefined),
    reset: spyOn(db, 'resetAnalysisCounter').mockImplementation(() => undefined),
  };
}

describe('deep analysis state', () => {
  let stubs: ReturnType<typeof stubStateDb>;
  beforeEach(() => {
    stubs = stubStateDb();
  });
  afterEach(() => {
    for (const spy of Object.values(stubs).reverse()) spy.mockRestore();
  });

  function acquire(analysisLimit = 3) {
    return acquireAnalysisLock({ ...SESSION, fingerprint: LOCK.fingerprint, analysisLimit });
  }

  it('creates a two-minute lock and increases the analysis count', () => {
    stubs.counter.mockReturnValue({ analysis_count: 1, updated_at: NOW });
    const result = acquire();
    expect(result).toMatchObject({
      analysisCount: 2,
      lock: {
        ...SESSION,
        fingerprint: LOCK.fingerprint,
        lock_expires_at: NOW + db.LOCK_LEASE_SECONDS,
      },
    });
    expect(result?.lock.lock_token).toBeString();
    expect(stubs.insert).toHaveBeenCalledWith(FAKE_DB, result?.lock);
    expect(stubs.write).toHaveBeenCalledWith(FAKE_DB, expect.objectContaining(SESSION), 2, NOW);
  });

  it('starts a missing counter at one', () => {
    expect(acquire()).toMatchObject({ analysisCount: 1 });
    expect(stubs.write).toHaveBeenCalledWith(FAKE_DB, expect.objectContaining(SESSION), 1, NOW);
  });

  it('gives each new lock a different token', () => {
    const first = acquire();
    const second = acquire();
    expect(first?.lock.lock_token).toBeTruthy();
    expect(second?.lock.lock_token).toBeTruthy();
    expect(first?.lock.lock_token).not.toBe(second?.lock.lock_token);
  });

  it('cleans up old records before reading saved state', () => {
    const calls: string[] = [];
    stubs.expire.mockImplementation(() => {
      calls.push('expire');
    });
    stubs.counter.mockImplementation(() => {
      calls.push('counter');
      return null;
    });
    acquire();
    expect(calls).toEqual(['expire', 'counter']);
    expect(stubs.counter).toHaveBeenCalledTimes(1);
    expect(stubs.successful).toHaveBeenCalledTimes(1);
    expect(stubs.lock).toHaveBeenCalledTimes(1);
  });

  it.each(['already analyzed', 'already running', 'at the limit'])(
    'skips analysis when %s without increasing the count',
    (reason) => {
      if (reason === 'already analyzed')
        stubs.successful.mockReturnValue({ fingerprint: LOCK.fingerprint, analyzed_at: NOW });
      if (reason === 'already running') stubs.lock.mockReturnValue(LOCK);
      if (reason === 'at the limit')
        stubs.counter.mockReturnValue({ analysis_count: 3, updated_at: NOW });
      expect(acquire()).toBeNull();
      expect(stubs.insert).not.toHaveBeenCalled();
      expect(stubs.write).not.toHaveBeenCalled();
    },
  );

  it('allows a new fingerprint while another analysis is running', () => {
    stubs.running.mockReturnValue(true);
    stubs.counter.mockReturnValue({ analysis_count: 1, updated_at: NOW });
    expect(acquire()).toMatchObject({ analysisCount: 2 });
  });

  it.each([null, { analysis_count: 0, updated_at: NOW }])(
    'rejects a missing or zero counter while analysis is running: %j',
    (counter) => {
      stubs.running.mockReturnValue(true);
      stubs.counter.mockReturnValue(counter);
      expect(acquire).toThrow(CommandFailedError);
      expect(resetAnalysisCounterIfIdle(SESSION)).toBe(false);
      expect(stubs.reset).not.toHaveBeenCalled();
      expect(stubs.write).not.toHaveBeenCalled();
      expect(stubs.reset).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['keeps the count when analysis will continue', 'continue', false, 2, true],
    [
      'keeps the count when analysis will continue and another is running',
      'continue',
      true,
      2,
      true,
    ],
    ['resets the count when the last analysis stops', 'stop', false, 0, true],
    ['keeps the count when one analysis stops but another is running', 'stop', true, 2, true],
    ['resets the count when the last analysis fails', 'failed', false, 0, false],
    ['keeps the count when one analysis fails but another is running', 'failed', true, 2, false],
  ] as const)('%s', (_description, outcome, running, expectedCount, successful) => {
    stubs.running.mockReturnValue(running);
    finishAnalysis(LOCK, outcome);
    expect(stubs.owner).toHaveBeenCalledWith(FAKE_DB, LOCK, NOW);
    expect(stubs.release).toHaveBeenCalledWith(FAKE_DB, LOCK.fingerprint);
    expect(stubs.write).toHaveBeenCalledWith(FAKE_DB, LOCK, expectedCount, NOW);
    if (successful) expect(stubs.record).toHaveBeenCalledWith(FAKE_DB, LOCK.fingerprint, NOW);
    else expect(stubs.record).not.toHaveBeenCalled();
  });

  it('does not save or delete data when the lock is invalid', () => {
    stubs.owner.mockImplementation(() => {
      throw new CommandFailedError('Expired owner');
    });
    expect(() => finishAnalysis(LOCK, 'stop')).toThrow(CommandFailedError);
    expect(stubs.record).not.toHaveBeenCalled();
    expect(stubs.release).not.toHaveBeenCalled();
    expect(stubs.write).not.toHaveBeenCalled();
  });

  it('resets the counter when no analysis is running', () => {
    expect(resetAnalysisCounterIfIdle(SESSION)).toBe(true);
    expect(stubs.reset).toHaveBeenCalledWith(FAKE_DB, SESSION, NOW);
  });

  it('keeps the counter while another analysis is running', () => {
    stubs.running.mockReturnValue(true);
    stubs.counter.mockReturnValue({ analysis_count: 2, updated_at: NOW });
    expect(resetAnalysisCounterIfIdle(SESSION)).toBe(false);
    expect(stubs.reset).not.toHaveBeenCalled();
  });

  it('reports database read errors without starting analysis', () => {
    const failure = new CommandFailedError('Storage unavailable');
    stubs.counter.mockImplementation(() => {
      throw failure;
    });
    expect(acquire).toThrow(failure);
    expect(stubs.insert).not.toHaveBeenCalled();
    expect(stubs.write).not.toHaveBeenCalled();
  });

  it('reports errors when saving the counter', () => {
    const failure = new CommandFailedError('Write failed');
    stubs.write.mockImplementation(() => {
      throw failure;
    });
    expect(() => finishAnalysis(LOCK, 'stop')).toThrow(failure);
  });

  it.each([0, -1, 1.5, NaN])(
    'rejects invalid analysis limits before using the database: %s',
    (limit) => {
      expect(() => acquire(limit)).toThrow(CommandFailedError);
      expect(stubs.state).not.toHaveBeenCalled();
    },
  );
});
