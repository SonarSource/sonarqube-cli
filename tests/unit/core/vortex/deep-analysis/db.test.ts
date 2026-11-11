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
import { dirname } from 'node:path';

import * as sqlite from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import * as config from '@/core/config-constants.ts';
import {
  COUNTER_RETENTION_SECONDS,
  deleteAnalysisLock,
  expireAnalysisState,
  hasRunningAnalysesForSession,
  insertAnalysisLock,
  type LockRow,
  openAnalysisDb,
  readAnalysisCounter,
  readAnalysisLock,
  readSuccessfulAnalysis,
  recordSuccessfulAnalysis,
  resetAnalysisCounter,
  SUCCESSFUL_ANALYSIS_RETENTION_SECONDS,
  validateAnalysisLockOwnership,
  withAnalysisState,
  writeAnalysisCounter,
} from '@/core/vortex/deep-analysis/db.ts';
import * as migrations from '@/core/vortex/deep-analysis/migrations.ts';

import { createDatabaseStub } from './helpers.ts';

const NOW = 1000;
const DB_PATH = '/virtual/sonar/deep-analysis.db';
const SESSION = { agent: 'claude', session_id: 'session' };
const LOCK: LockRow = {
  ...SESSION,
  fingerprint: 'untrusted-fingerprint',
  lock_token: 'owner',
  lock_expires_at: NOW + 120,
};
const COUNTER = { analysis_count: 2, updated_at: NOW };
const constructors = sqlite as unknown as {
  Database: (...args: ConstructorParameters<typeof sqlite.Database>) => sqlite.Database;
};

function mockDatabaseSetup(fake: ReturnType<typeof createDatabaseStub>) {
  return {
    mkdir: spyOn(fs, 'mkdirSync').mockImplementation(() => undefined),
    path: spyOn(config, 'getVortexAnalysisDbPath').mockReturnValue(DB_PATH),
    construct: spyOn(constructors, 'Database').mockImplementation(function () {
      return fake.db;
    }),
    migrate: spyOn(migrations, 'applyAnalysisMigrations').mockImplementation(() => undefined),
    clock: spyOn(Date, 'now').mockReturnValue(NOW * 1000 + 123),
  };
}

describe('deep analysis database', () => {
  let fake: ReturnType<typeof createDatabaseStub>;
  let stubs: ReturnType<typeof mockDatabaseSetup>;
  beforeEach(() => {
    fake = createDatabaseStub();
    stubs = mockDatabaseSetup(fake);
  });
  afterEach(() => {
    for (const spy of Object.values(stubs).reverse()) spy.mockRestore();
  });

  it('opens the database and prepares it for use', () => {
    stubs.migrate.mockImplementation(() => {
      expect(fake.run).toHaveBeenCalledTimes(2);
    });
    expect(openAnalysisDb()).toBe(fake.db);
    expect(stubs.mkdir).toHaveBeenCalledWith(dirname(DB_PATH), { recursive: true });
    expect(stubs.construct).toHaveBeenCalledWith(DB_PATH, { create: true, strict: true });
    expect(fake.run.mock.calls).toEqual([
      ['PRAGMA busy_timeout = 1000'],
      ['PRAGMA journal_mode = WAL'],
    ]);
    expect(stubs.migrate).toHaveBeenCalledWith(fake.db);
    expect(fake.close).not.toHaveBeenCalled();
  });

  it.each(['directory', 'constructor', 'WAL', 'migration'] as const)(
    'reports a %s error and closes the database if it was opened',
    (stage) => {
      const failure = new Error(`${stage} unavailable`);
      if (stage === 'directory')
        stubs.mkdir.mockImplementation(() => {
          throw failure;
        });
      if (stage === 'constructor')
        stubs.construct.mockImplementation(() => {
          throw failure;
        });
      if (stage === 'WAL')
        fake.run.mockImplementation((sql) => {
          if (sql.includes('journal_mode')) throw failure;
          return undefined;
        });
      if (stage === 'migration')
        stubs.migrate.mockImplementation(() => {
          throw failure;
        });
      let error: unknown;
      try {
        openAnalysisDb();
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(CommandFailedError);
      expect(error).toMatchObject({ cause: failure });
      expect(fake.close).toHaveBeenCalledTimes(stage === 'WAL' || stage === 'migration' ? 1 : 0);
      if (stage === 'WAL')
        expect(fake.run.mock.calls.filter(([sql]) => sql.includes('journal_mode'))).toHaveLength(1);
    },
  );

  it('uses one transaction and closes the database', () => {
    const result = withAnalysisState((database, now) => {
      expect(database).toBe(fake.db);
      expect(now).toBe(NOW);
      return 'result';
    });
    expect(result).toBe('result');
    expect(fake.transaction).toHaveBeenCalledTimes(1);
    expect(fake.immediate).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('closes the database when the operation fails', () => {
    const failure = new Error('Operation failed');
    let error: unknown;
    try {
      withAnalysisState(() => {
        throw failure;
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({ cause: failure });
    expect(error).toBeInstanceOf(CommandFailedError);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('closes the database when the transaction cannot start', () => {
    const failure = new Error('Database busy');
    fake.transaction.mockReturnValue({ immediate: fake.immediate });
    fake.immediate.mockImplementation(() => {
      throw failure;
    });
    let operationCalled = false;
    let error: unknown;
    try {
      withAnalysisState(() => {
        operationCalled = true;
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(CommandFailedError);
    expect(error).toMatchObject({ cause: failure });
    expect(operationCalled).toBe(false);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('reads the counter for the requested session', () => {
    expect(readAnalysisCounter(fake.db, SESSION)).toBeNull();
    fake.get.mockReturnValue(COUNTER);
    expect(readAnalysisCounter(fake.db, SESSION)).toEqual(COUNTER);
    expect(fake.get).toHaveBeenLastCalledWith(SESSION.agent, SESSION.session_id);
  });

  it.each([
    { analysis_count: -1, updated_at: NOW },
    { analysis_count: 1.5, updated_at: NOW },
    { analysis_count: 2, updated_at: NaN },
  ])('rejects invalid counters: %j', (row) => {
    fake.get.mockReturnValue(row);
    expect(() => readAnalysisCounter(fake.db, SESSION)).toThrow(CommandFailedError);
  });

  it('reads successful analyses and rejects invalid saved data', () => {
    expect(readSuccessfulAnalysis(fake.db, LOCK.fingerprint)).toBeNull();
    fake.get.mockReturnValue({ fingerprint: LOCK.fingerprint, analyzed_at: NOW });
    expect(readSuccessfulAnalysis(fake.db, LOCK.fingerprint)).toEqual({
      fingerprint: LOCK.fingerprint,
      analyzed_at: NOW,
    });
    fake.get.mockReturnValue({ fingerprint: '', analyzed_at: NOW });
    expect(() => readSuccessfulAnalysis(fake.db, LOCK.fingerprint)).toThrow(CommandFailedError);
  });

  it('reads locks and rejects invalid saved data', () => {
    expect(readAnalysisLock(fake.db, LOCK.fingerprint)).toBeNull();
    fake.get.mockReturnValue(LOCK);
    expect(readAnalysisLock(fake.db, LOCK.fingerprint)).toEqual(LOCK);
    fake.get.mockReturnValue({ ...LOCK, lock_token: '' });
    expect(() => readAnalysisLock(fake.db, LOCK.fingerprint)).toThrow(CommandFailedError);
  });

  it.each([
    null,
    { ...LOCK, lock_token: 'other' },
    { ...LOCK, agent: 'codex' },
    { ...LOCK, session_id: 'other' },
    { ...LOCK, lock_expires_at: NOW },
  ])('rejects missing, changed, or expired locks: %j', (row) => {
    fake.get.mockReturnValueOnce(row).mockReturnValueOnce(COUNTER);
    expect(() => validateAnalysisLockOwnership(fake.db, LOCK, NOW)).toThrow(CommandFailedError);
  });

  it.each([null, { analysis_count: 0, updated_at: NOW }])(
    'rejects a lock with a missing or zero counter: %j',
    (counter) => {
      fake.get.mockReturnValueOnce(LOCK).mockReturnValueOnce(counter);
      expect(() => validateAnalysisLockOwnership(fake.db, LOCK, NOW)).toThrow(CommandFailedError);
    },
  );

  it('uses the expiry time saved in the database', () => {
    fake.get.mockReturnValueOnce(LOCK).mockReturnValueOnce(COUNTER);
    expect(validateAnalysisLockOwnership(fake.db, { ...LOCK, lock_expires_at: 0 }, NOW)).toEqual(
      COUNTER,
    );
  });

  it('checks for running analyses in the requested session', () => {
    fake.get.mockReturnValue({ active: 1 });
    expect(hasRunningAnalysesForSession(fake.db, SESSION, NOW)).toBe(true);
    expect(fake.get).toHaveBeenCalledWith(SESSION.agent, SESSION.session_id, NOW);
    fake.get.mockReturnValue({ active: 0 });
    expect(hasRunningAnalysesForSession(fake.db, SESSION, NOW)).toBe(false);
  });

  it('passes values separately from SQL text', () => {
    insertAnalysisLock(fake.db, LOCK);
    writeAnalysisCounter(fake.db, SESSION, 3, NOW);
    resetAnalysisCounter(fake.db, SESSION, NOW);
    recordSuccessfulAnalysis(fake.db, LOCK.fingerprint, NOW);
    deleteAnalysisLock(fake.db, LOCK.fingerprint);
    expect(fake.runStatement.mock.calls).toEqual([
      [LOCK.fingerprint, LOCK.lock_token, LOCK.lock_expires_at, SESSION.agent, SESSION.session_id],
      [SESSION.agent, SESSION.session_id, 3, NOW],
      [NOW, SESSION.agent, SESSION.session_id],
      [LOCK.fingerprint, NOW],
      [LOCK.fingerprint],
    ]);
    expect(fake.prepare.mock.calls.every(([sql]) => !sql.includes(LOCK.fingerprint))).toBe(true);
  });

  it('uses the right expiry times when deleting old records', () => {
    expireAnalysisState(fake.db, NOW);
    expect(fake.runStatement.mock.calls).toEqual([
      [NOW],
      [NOW - SUCCESSFUL_ANALYSIS_RETENTION_SECONDS],
      [NOW - COUNTER_RETENTION_SECONDS],
    ]);
    expect(fake.prepare.mock.calls[2]?.[0]).toContain('NOT EXISTS');
    expect(fake.prepare.mock.calls[2]?.[0]).toContain('vortex_analysis_locks');
  });
});
