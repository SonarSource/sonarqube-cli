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
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import * as config from '@/core/config-constants.ts';
import * as db from '@/core/vortex/deep-analysis/db.ts';
import * as migrations from '@/core/vortex/deep-analysis/migrations.ts';
import { acquireAnalysisLock } from '@/core/vortex/deep-analysis/state.ts';

const NOW = 1000;
const DB_PATH = '/virtual/sonar/deep-analysis.db';
const constructors = sqlite as unknown as {
  Database: (...args: ConstructorParameters<typeof sqlite.Database>) => sqlite.Database;
};

function createDatabaseStub() {
  const get = mock<(...bindings: unknown[]) => unknown>(() => null);
  const all = mock<(...bindings: unknown[]) => unknown[]>(() => []);
  const runStatement = mock((..._bindings: unknown[]) => undefined);
  const prepare = mock((_sql: string) => ({ get, all, run: runStatement }));
  const run = mock((_sql: string) => undefined);
  const close = mock(() => undefined);
  const immediate = mock<() => unknown>(() => undefined);
  const transaction = mock((callback: () => unknown) => {
    immediate.mockImplementation(callback);
    return { immediate };
  });
  const db = { prepare, run, close, transaction } as unknown as sqlite.Database;
  return { db, prepare, get, all, runStatement, run, close, immediate, transaction };
}

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

  it.each(['WAL', 'migration'] as const)(
    'closes the database and preserves the cause after a %s error',
    (stage) => {
      const failure = new Error(`${stage} unavailable`);
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
        db.openAnalysisDb();
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(CommandFailedError);
      expect(error).toMatchObject({ cause: failure });
      expect(fake.close).toHaveBeenCalledTimes(1);
      if (stage === 'WAL')
        expect(fake.run.mock.calls.filter(([sql]) => sql.includes('journal_mode'))).toHaveLength(1);
    },
  );

  it.each(['SQLITE_NOTADB', 'SQLITE_CORRUPT', 'SQLITE_CORRUPT_VTAB'])(
    'quarantines database files and retries after %s',
    (code) => {
      stubs.migrate.mockImplementationOnce(() => {
        throw Object.assign(new Error('Corrupt database'), { code });
      });
      const rename = spyOn(fs, 'renameSync').mockImplementation(() => {
        expect(fake.close).toHaveBeenCalledTimes(1);
      });
      try {
        expect(db.openAnalysisDb()).toBe(fake.db);
        expect(rename.mock.calls).toEqual(
          [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`].map((path) => [
            path,
            `${path}.corrupted-${NOW * 1000 + 123}`,
          ]),
        );
        expect(stubs.construct).toHaveBeenCalledTimes(2);
        expect(stubs.migrate).toHaveBeenCalledTimes(2);
      } finally {
        rename.mockRestore();
      }
    },
  );

  it('retries only once even when quarantining files fails', () => {
    const failure = Object.assign(new Error('Corrupt database'), { code: 'SQLITE_CORRUPT' });
    stubs.migrate.mockImplementation(() => {
      throw failure;
    });
    const rename = spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('File unavailable');
    });
    try {
      expect(() => db.openAnalysisDb()).toThrow(CommandFailedError);
      expect(stubs.construct).toHaveBeenCalledTimes(2);
      expect(fake.close).toHaveBeenCalledTimes(2);
      expect(rename).toHaveBeenCalledTimes(3);
    } finally {
      rename.mockRestore();
    }
  });

  it('closes the database when the operation fails', () => {
    const failure = new Error('Operation failed');
    let error: unknown;
    try {
      db.withAnalysisState(() => {
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
      db.withAnalysisState(() => {
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
});

describe('deep analysis migration failures', () => {
  let fake: ReturnType<typeof createDatabaseStub>;
  beforeEach(() => {
    fake = createDatabaseStub();
  });

  it('does not save a new version when database setup fails', () => {
    const failure = new Error('DDL unavailable');
    fake.get.mockReturnValueOnce({ user_version: 0 }).mockReturnValueOnce({ count: 0 });
    fake.run.mockImplementation(() => {
      throw failure;
    });
    expect(() => migrations.applyAnalysisMigrations(fake.db)).toThrow(failure);
    expect(fake.run).toHaveBeenCalledTimes(1);
    expect(fake.all).not.toHaveBeenCalled();
  });
});

describe('deep analysis input validation', () => {
  let state: ReturnType<typeof spyOn<typeof db, 'withAnalysisState'>>;
  beforeEach(() => {
    state = spyOn(db, 'withAnalysisState').mockImplementation(() => {
      throw new Error('Unexpected database access');
    });
  });
  afterEach(() => {
    state.mockRestore();
  });

  it('rejects a zero analysis limit before using the database', () => {
    expect(() =>
      acquireAnalysisLock({
        agent: 'claude',
        session_id: 'session',
        fingerprint: 'fingerprint',
        analysisLimit: 0,
      }),
    ).toThrow(CommandFailedError);
    expect(state).not.toHaveBeenCalled();
  });
});
