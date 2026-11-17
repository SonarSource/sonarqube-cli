/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { readdirSync } from 'node:fs';

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { CliResult } from '../../harness';
import { TestHarness } from '../../harness';
import type {
  FakeSonarQubeServer,
  SqaaResponseConfig,
} from '../../harness/fake-sonarqube-server.ts';
import { parseSqaaRequestBody } from '../analyze/sqaa-request-helpers.ts';
import { git, initGitRepo } from './git-test-helpers.ts';

const COMMAND = 'hook agent-stop --agent claude';
const ISSUE = { rule: 'typescript:S2688', message: 'Use Number.isNaN.', startLine: 2 };
const BAD = 'export function invalid(value: number): boolean {\n  return value === NaN;\n}\n';
const GOOD =
  'export function invalid(value: number): boolean {\n  return Number.isNaN(value);\n}\n';

describe('agent stop hook', () => {
  let harness: TestHarness;
  let response: SqaaResponseConfig;
  let server: FakeSonarQubeServer;
  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=project\n');
    harness.cwd.writeFile('src/tracked.ts', BAD);
    git(['add', '.'], harness.cwd.path);
    git(['commit', '-m', 'baseline'], harness.cwd.path);
    response = { issues: [{ ...ISSUE }] };
    server = await harness
      .newFakeServer()
      .withAuthToken('test-token')
      .withSqaaResponse(response)
      .start();
    harness.withAuth(server.baseUrl(), 'test-token', 'org');
  });
  afterEach(async () => {
    await harness.dispose();
  });
  function invoke(extra = {}) {
    return harness.runWithStdin(
      COMMAND,
      JSON.stringify({
        session_id: 'session',
        cwd: harness.cwd.path,
        hook_event_name: 'Stop',
        ...extra,
      }),
    );
  }
  function analyses() {
    return server
      .getRecordedRequests()
      .filter(({ path }) => path === '/api/v2/a3s/analyses' || path === '/a3s-analysis/analyses');
  }
  function withDb<T>(operation: (db: Database) => T): T {
    const db = new Database(harness.cliHome.file('db/hooks/stop-hook-vortex-analysis.db').path, {
      strict: true,
    });
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }
  function queryState(sessionId = 'session') {
    return withDb((db) => {
      const row = db
        .query<{ count: number | null; locks: number; successful: number }, [string]>(
          `
        SELECT
          (SELECT analysis_count FROM vortex_analysis_counters
            WHERE agent = 'claude' AND session_id = ?) AS count,
          (SELECT count(*) FROM vortex_analysis_locks) AS locks,
          (SELECT count(*) FROM vortex_successful_analyses) AS successful
      `,
        )
        .get(sessionId);
      return { count: row?.count ?? undefined, locks: row?.locks, successful: row?.successful };
    });
  }

  function readSessionCounters() {
    return withDb((db) =>
      Object.fromEntries<number>(
        db
          .query<{ session_id: string; analysis_count: number }, []>(
            "SELECT session_id, analysis_count FROM vortex_analysis_counters WHERE agent = 'claude'",
          )
          .all()
          .map(({ session_id, analysis_count }) => [session_id, analysis_count]),
      ),
    );
  }

  async function whileAnalysisRuns(operation: () => void | Promise<void>) {
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    response.beforeSqaaResponse = async () => {
      received.resolve();
      await release.promise;
    };
    const running = invoke();
    try {
      await Promise.race([
        received.promise,
        running.then(() => {
          throw new Error('Analysis did not start');
        }),
      ]);
      response.beforeSqaaResponse = undefined;
      await operation();
    } finally {
      release.resolve();
      await running;
    }
    return running;
  }

  function readLocks() {
    return withDb((db) =>
      db
        .query<
          {
            fingerprint: string;
            lock_token: string;
            lock_expires_at: number;
            agent: string;
            session_id: string;
          },
          []
        >('SELECT * FROM vortex_analysis_locks ORDER BY fingerprint')
        .all(),
    );
  }

  function databaseFiles() {
    return readdirSync(harness.cliHome.file('db/hooks').path);
  }

  function expectSilentStop(result: CliResult): void {
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  }

  describe('database setup and recovery', () => {
    it('creates the analysis tables once and reuses them on later hook calls', async () => {
      expectSilentStop(await invoke());
      expect(analyses()).toHaveLength(0);
      expect(queryState()).toEqual({ count: 0, locks: 0, successful: 0 });
      const metadata = () =>
        withDb((db) => ({
          version: db.query('PRAGMA user_version').get(),
          journal: db.query('PRAGMA journal_mode').get(),
          tables: db
            .query("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all(),
        }));
      const created = metadata();
      expect(created.version).toEqual({ user_version: 1 });
      expect(created.journal).toEqual({ journal_mode: 'wal' });
      expect(created.tables).toHaveLength(3);
      harness.cwd.writeFile('src/new.ts', BAD);
      expect(JSON.parse((await invoke()).stdout).decision).toBe('block');
      expect(metadata()).toEqual(created);
      expect(queryState()).toEqual({ count: 1, locks: 0, successful: 1 });
    }, 30000);

    it('prevents invalid counts, timestamps, and empty identifiers from being stored', async () => {
      await invoke();
      withDb((db) => {
        for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
          expect(() =>
            db.run('INSERT INTO vortex_analysis_counters VALUES (?, ?, ?, ?)', [
              'claude',
              'invalid',
              count,
              1,
            ]),
          ).toThrow();
        }
        for (const agent of ['', null]) {
          expect(() =>
            db.run('INSERT INTO vortex_analysis_counters VALUES (?, ?, ?, ?)', [
              agent,
              'invalid',
              1,
              1,
            ]),
          ).toThrow();
        }
        expect(() =>
          db.run('INSERT INTO vortex_analysis_counters VALUES (?, ?, ?, ?)', [
            'claude',
            'invalid',
            1,
            -1,
          ]),
        ).toThrow();
        expect(() =>
          db.run('INSERT INTO vortex_successful_analyses VALUES (?, ?)', ['invalid', -1]),
        ).toThrow();
        expect(() =>
          db.run('INSERT INTO vortex_successful_analyses VALUES (?, ?)', ['', 1]),
        ).toThrow();
        expect(() =>
          db.run('INSERT INTO vortex_analysis_locks VALUES (?, ?, ?, ?, ?)', [
            'invalid',
            'owner',
            -1,
            'claude',
            'invalid',
          ]),
        ).toThrow();
        expect(() =>
          db.run('INSERT INTO vortex_analysis_locks VALUES (?, ?, ?, ?, ?)', [
            'invalid',
            '',
            1,
            'claude',
            'invalid',
          ]),
        ).toThrow();
      });
      expect(queryState()).toEqual({ count: 0, locks: 0, successful: 0 });
    }, 15000);

    it.each([-1, 2])(
      'skips analysis and preserves the database when its schema version is %i',
      async (version) => {
        await invoke();
        withDb((db) => db.run(`PRAGMA user_version = ${version}`));
        harness.cwd.writeFile('src/new.ts', BAD);
        const result = await invoke();
        expectSilentStop(result);
        expect(analyses()).toHaveLength(0);
        expect(withDb((db) => db.query('PRAGMA user_version').get())).toEqual({
          user_version: version,
        });
        expect(databaseFiles().some((name) => name.includes('.corrupted-'))).toBe(false);
      },
      30000,
    );

    it('skips analysis without overwriting data in an unversioned database', async () => {
      harness.cliHome.writeFile('db/hooks/stop-hook-vortex-analysis.db', '');
      withDb((db) => {
        db.run('CREATE TABLE existing_data (value TEXT)');
        db.run("INSERT INTO existing_data VALUES ('preserve me')");
      });
      harness.cwd.writeFile('src/new.ts', BAD);
      const result = await invoke();
      expectSilentStop(result);
      expect(analyses()).toHaveLength(0);
      expect(withDb((db) => db.query('SELECT * FROM existing_data').all())).toEqual([
        { value: 'preserve me' },
      ]);
      expect(withDb((db) => db.query('PRAGMA user_version').get())).toEqual({
        user_version: 0,
      });
    }, 15000);

    it.each([
      ['the counter table is missing', 'DROP TABLE vortex_analysis_counters'],
      ['the results table is missing', 'DROP TABLE vortex_successful_analyses'],
      ['the locks table is missing', 'DROP TABLE vortex_analysis_locks'],
      [
        'a required column is missing',
        'ALTER TABLE vortex_analysis_counters RENAME COLUMN updated_at TO wrong_column',
      ],
      [
        'the counter table has no primary key',
        `DROP TABLE vortex_analysis_counters;
     CREATE TABLE vortex_analysis_counters (agent TEXT NOT NULL, session_id TEXT NOT NULL,
       analysis_count INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
      ],
      [
        'lock tokens can be null',
        `DROP TABLE vortex_analysis_locks;
     CREATE TABLE vortex_analysis_locks (fingerprint TEXT PRIMARY KEY NOT NULL, lock_token TEXT,
       lock_expires_at INTEGER NOT NULL, agent TEXT NOT NULL, session_id TEXT NOT NULL)`,
      ],
      [
        'the attempt count column has the wrong type',
        `DROP TABLE vortex_analysis_counters;
     CREATE TABLE vortex_analysis_counters (agent TEXT NOT NULL, session_id TEXT NOT NULL,
       analysis_count TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (agent, session_id))`,
      ],
    ])(
      'skips analysis and preserves the database when %s',
      async (_description, sql) => {
        await invoke();
        withDb((db) => db.exec(sql));
        const schema = () =>
          withDb((db) => db.query('SELECT name, sql FROM sqlite_master ORDER BY name').all());
        const before = schema();
        harness.cwd.writeFile('src/new.ts', BAD);
        const result = await invoke();
        expectSilentStop(result);
        expect(analyses()).toHaveLength(0);
        expect(schema()).toEqual(before);
        expect(databaseFiles().some((name) => name.includes('.corrupted-'))).toBe(false);
      },
      30000,
    );

    it.each([
      ['a file blocks creation of the database directory', 'db/hooks'],
      ['the database path is a directory', 'db/hooks/stop-hook-vortex-analysis.db/marker'],
    ])(
      'allows stopping when %s',
      async (_description, path) => {
        harness.cliHome.writeFile(path, 'conflicting entry');
        harness.cwd.writeFile('src/new.ts', BAD);
        const result = await invoke();
        expectSilentStop(result);
        expect(analyses()).toHaveLength(0);
      },
      15000,
    );

    it('skips analysis while the database is locked and retries after it is unlocked', async () => {
      await invoke();
      const blocker = new Database(
        harness.cliHome.file('db/hooks/stop-hook-vortex-analysis.db').path,
      );
      harness.cwd.writeFile('src/new.ts', BAD);
      blocker.run('BEGIN IMMEDIATE');
      try {
        const result = await invoke();
        expectSilentStop(result);
        expect(analyses()).toHaveLength(0);
        expect(databaseFiles().some((name) => name.includes('.corrupted-'))).toBe(false);
      } finally {
        blocker.run('ROLLBACK');
        blocker.close();
      }
      expect(JSON.parse((await invoke()).stdout).decision).toBe('block');
      expect(queryState()).toEqual({ count: 1, locks: 0, successful: 1 });
    }, 30000);

    it('removes the new lock if saving the attempt count fails', async () => {
      await invoke();
      withDb((db) =>
        db.run(`CREATE TRIGGER fail_counter BEFORE INSERT ON vortex_analysis_counters
      BEGIN SELECT RAISE(ABORT, 'Test counter write failure'); END`),
      );
      harness.cwd.writeFile('src/new.ts', BAD);
      const result = await invoke();
      expectSilentStop(result);
      expect(analyses()).toHaveLength(0);
      expect(queryState()).toEqual({ count: 0, locks: 0, successful: 0 });
      withDb((db) => db.run('DROP TRIGGER fail_counter'));
      expect(JSON.parse((await invoke()).stdout).decision).toBe('block');
      expect(queryState()).toEqual({ count: 1, locks: 0, successful: 1 });
    }, 30000);

    it.each([
      ['analysis result', 'vortex_successful_analyses'],
      ['attempt count', 'vortex_analysis_counters'],
    ])(
      'keeps the lock and cached results unchanged when saving the %s fails',
      async (_description, table) => {
        harness.cwd.writeFile('src/new.ts', GOOD);
        response.issues = [];
        expectSilentStop(await invoke());
        const cachedResults = () =>
          withDb((db) => db.query('SELECT * FROM vortex_successful_analyses').all());
        const before = cachedResults();
        harness.cwd.writeFile('src/new.ts', BAD);
        response.issues = [{ ...ISSUE }];
        let locks: ReturnType<typeof readLocks> = [];
        const result = await whileAnalysisRuns(() => {
          locks = readLocks();
          withDb((db) =>
            db.run(`CREATE TRIGGER fail_completion BEFORE INSERT ON ${table}
            BEGIN SELECT RAISE(ABORT, 'Test completion write failure'); END`),
          );
        });
        expectSilentStop(result);
        expect(analyses()).toHaveLength(2);
        expect(queryState()).toEqual({ count: 1, locks: 1, successful: 1 });
        expect(readLocks()).toEqual(locks);
        expect(cachedResults()).toEqual(before);
      },
      30000,
    );

    it('allows stopping after corruption and analyzes on a later invocation', async () => {
      harness.cwd.writeFile('src/new.ts', BAD);
      harness.cliHome.writeFile('db/hooks/stop-hook-vortex-analysis.db', 'corrupt database');
      expectSilentStop(await invoke());
      expect(analyses()).toHaveLength(0);
      expect(queryState()).toEqual({ count: undefined, locks: 0, successful: 0 });
      const result = await invoke();
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).decision).toBe('block');
      expect(analyses()).toHaveLength(1);
      expect(queryState()).toEqual({ count: 1, locks: 0, successful: 1 });
      expect(
        readdirSync(harness.cliHome.file('db/hooks').path).some((name) =>
          name.startsWith('stop-hook-vortex-analysis.db.corrupted-'),
        ),
      ).toBe(true);
    }, 15000);

    it('allows stopping when corruption recurs across hook invocations', async () => {
      harness.cwd.writeFile('src/new.ts', BAD);
      for (let attempt = 0; attempt < 4; attempt++) {
        harness.cliHome.writeFile('db/hooks/stop-hook-vortex-analysis.db', 'corrupt database');
        expectSilentStop(await invoke());
        expect(analyses()).toHaveLength(0);
        expect(queryState()).toEqual({ count: undefined, locks: 0, successful: 0 });
      }
    }, 30000);
  });

  describe('session counters and cached analyses', () => {
    it('treats SQL in session IDs as data and keeps agent counters separate', async () => {
      const sessionId = "session'); DROP TABLE vortex_analysis_locks; --";
      await invoke({ session_id: sessionId });
      withDb((db) =>
        db.run('INSERT INTO vortex_analysis_counters VALUES (?, ?, ?, ?)', [
          'codex',
          sessionId,
          2,
          Math.floor(Date.now() / 1000),
        ]),
      );
      harness.cwd.writeFile('src/new.ts', BAD);
      expect(JSON.parse((await invoke({ session_id: sessionId })).stdout).decision).toBe('block');
      expect(
        withDb((db) =>
          db
            .query('SELECT agent, analysis_count FROM vortex_analysis_counters ORDER BY agent')
            .all(),
        ),
      ).toEqual([
        { agent: 'claude', analysis_count: 1 },
        { agent: 'codex', analysis_count: 2 },
      ]);
      await invoke({ session_id: sessionId });
      expect(
        withDb((db) =>
          db
            .query('SELECT agent, analysis_count FROM vortex_analysis_counters ORDER BY agent')
            .all(),
        ),
      ).toEqual([
        { agent: 'claude', analysis_count: 0 },
        { agent: 'codex', analysis_count: 2 },
      ]);
    }, 30000);

    it('reanalyzes expired results and removes stale state while preserving recent and running sessions', async () => {
      harness.cwd.writeFile('src/new.ts', BAD);
      expect(JSON.parse((await invoke()).stdout).decision).toBe('block');
      const now = Math.floor(Date.now() / 1000);
      withDb((db) => {
        db.run('UPDATE vortex_successful_analyses SET analyzed_at = 1');
        db.run('UPDATE vortex_analysis_counters SET updated_at = 1');
        for (const [session, expires] of [
          ['expired', 1],
          ['live', now + 3600],
        ] as const) {
          db.run('INSERT INTO vortex_analysis_counters VALUES (?, ?, ?, ?)', [
            'claude',
            session,
            2,
            1,
          ]);
          db.run('INSERT INTO vortex_analysis_locks VALUES (?, ?, ?, ?, ?)', [
            session,
            session,
            expires,
            'claude',
            session,
          ]);
        }
        db.run('INSERT INTO vortex_analysis_counters VALUES (?, ?, ?, ?)', [
          'claude',
          'fresh',
          2,
          now,
        ]);
        db.run('INSERT INTO vortex_analysis_counters VALUES (?, ?, ?, ?)', [
          'claude',
          'abandoned',
          3,
          1,
        ]);
        db.run('INSERT INTO vortex_successful_analyses VALUES (?, ?)', ['fresh', now]);
      });
      expect(JSON.parse((await invoke()).stdout).decision).toBe('block');
      expect(analyses()).toHaveLength(2);
      expect(readSessionCounters()).toEqual({ session: 1, live: 2, fresh: 2 });
      expect(queryState()).toEqual({ count: 1, locks: 1, successful: 2 });
      expect(readLocks().map(({ fingerprint }) => fingerprint)).toEqual(['live']);
      expect(
        withDb((db) => db.query('SELECT fingerprint FROM vortex_successful_analyses').all()),
      ).toContainEqual({ fingerprint: 'fresh' });
    }, 30000);

    it('skips analysis and resets the counter when the session has already used three attempts', async () => {
      await invoke();
      withDb((db) => db.run('UPDATE vortex_analysis_counters SET analysis_count = 3'));
      harness.cwd.writeFile('src/new.ts', BAD);
      const result = await invoke();
      expectSilentStop(result);
      expect(analyses()).toHaveLength(0);
      expect(queryState()).toEqual({ count: 0, locks: 0, successful: 0 });
    }, 30000);

    it('retries unchanged files after analysis fails', async () => {
      harness.cwd.writeFile('src/new.ts', BAD);
      response.errors = [{ code: 'failure', message: 'Analysis incomplete' }];
      expectSilentStop(await invoke());
      expect(queryState()).toEqual({ count: 0, locks: 0, successful: 0 });
      response.errors = [];
      const retried = await invoke();
      expect(retried.exitCode).toBe(0);
      expect(JSON.parse(retried.stdout).decision).toBe('block');
      expect(analyses()).toHaveLength(2);
      expect(queryState()).toEqual({ count: 1, locks: 0, successful: 1 });
    }, 30000);

    it('shares saved findings across sessions', async () => {
      harness.cwd.writeFile('src/new.ts', BAD);
      expect(JSON.parse((await invoke()).stdout).decision).toBe('block');
      const other = await invoke({ session_id: 'other' });
      expectSilentStop(other);
      expect(analyses()).toHaveLength(1);
      expect(queryState()).toEqual({ count: 1, locks: 0, successful: 1 });
      expect(readSessionCounters().other).toBeUndefined();
    }, 30000);

    it('keeps session counters and resets separate', async () => {
      harness.cwd.writeFile('src/new.ts', BAD);
      await invoke();
      harness.cwd.writeFile('src/new.ts', BAD + '// another change\n');
      await invoke({ session_id: 'other' });
      expect(readSessionCounters()).toEqual({ session: 1, other: 1 });
      await invoke({ session_id: 'other' });
      expect(readSessionCounters()).toEqual({ session: 1, other: 0 });
      harness.cwd.writeFile('src/new.ts', BAD + '// third change\n');
      expect(JSON.parse((await invoke()).stdout).decision).toBe('block');
      expect(readSessionCounters()).toEqual({ session: 2, other: 0 });
      expect(analyses()).toHaveLength(3);
    }, 30000);

    it('asks for fixes until analysis is clean', async () => {
      harness.cwd.writeFile('src/tracked.ts', BAD + '\n');
      const first = await invoke();
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({
        decision: 'block',
        reason: expect.stringContaining('Use Number.isNaN.'),
      });
      expect(queryState()).toEqual({ count: 1, locks: 0, successful: 1 });
      expect(parseSqaaRequestBody(analyses()[0].body).analysisDepth).toBe('DEEP');
      harness.cwd.writeFile('src/tracked.ts', GOOD);
      response.issues = [];
      const second = await invoke({ stop_hook_active: true });
      expectSilentStop(second);
      expect(analyses()).toHaveLength(2);
      expect(queryState()).toEqual({ count: 0, locks: 0, successful: 2 });
      expectSilentStop(await invoke());
      expect(analyses()).toHaveLength(2);
    }, 30000);

    it('allows stopping at the analysis limit even with findings', async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        harness.cwd.writeFile('src/new.ts', BAD + `// attempt ${attempt}\n`);
        const result = await invoke();
        expect(result.exitCode).toBe(0);
        if (attempt < 3) expect(JSON.parse(result.stdout).decision).toBe('block');
        else
          expect(JSON.parse(result.stdout)).toEqual({
            systemMessage: expect.stringContaining(
              'Vortex analysis reached its limit of 3 attempts.',
            ),
          });
        if (attempt === 3)
          expect(JSON.parse(result.stdout).systemMessage).toContain('Use Number.isNaN.');
      }
      expect(analyses()).toHaveLength(3);
      expect(queryState()).toEqual({ count: 0, locks: 0, successful: 3 });
    }, 30000);
  });

  describe('locks and concurrent analyses', () => {
    it.each([
      ['missing', null],
      ['zero', 0],
    ] as const)(
      'skips analysis and preserves running locks when the session counter is %s',
      async (_description, count) => {
        await invoke();
        withDb((db) => {
          if (count === null) db.run('DELETE FROM vortex_analysis_counters');
          db.run('INSERT INTO vortex_analysis_locks VALUES (?, ?, ?, ?, ?)', [
            'in-flight',
            'owner',
            Math.floor(Date.now() / 1000) + 3600,
            'claude',
            'session',
          ]);
        });
        const locks = readLocks();
        harness.cwd.writeFile('src/new.ts', BAD);
        const result = await invoke();
        expectSilentStop(result);
        expect(analyses()).toHaveLength(0);
        expect(queryState()).toEqual({ count: count ?? undefined, locks: 1, successful: 0 });
        expect(readLocks()).toEqual(locks);
      },
      30000,
    );

    it.each([
      ['its lock was deleted', 'missing'],
      ['its lock token changed', 'token'],
      ['its lock belongs to another agent', 'agent'],
      ['its lock belongs to another session', 'session'],
      ['its lock expired', 'expired'],
      ['its session counter was deleted', 'missing-counter'],
      ['its session counter was reset to zero', 'zero-counter'],
    ])(
      'discards the analysis result when %s',
      async (_description, scenario) => {
        harness.cwd.writeFile('src/new.ts', BAD);
        let locks: ReturnType<typeof readLocks> = [];
        const result = await whileAnalysisRuns(() => {
          withDb((db) => {
            if (scenario === 'missing') db.run('DELETE FROM vortex_analysis_locks');
            if (scenario === 'token')
              db.run("UPDATE vortex_analysis_locks SET lock_token = 'replacement'");
            if (scenario === 'agent') db.run("UPDATE vortex_analysis_locks SET agent = 'codex'");
            if (scenario === 'session')
              db.run("UPDATE vortex_analysis_locks SET session_id = 'replacement'");
            if (scenario === 'expired')
              db.run('UPDATE vortex_analysis_locks SET lock_expires_at = 1');
            if (scenario === 'missing-counter') db.run('DELETE FROM vortex_analysis_counters');
            if (scenario === 'zero-counter')
              db.run('UPDATE vortex_analysis_counters SET analysis_count = 0');
          });
          locks = readLocks();
        });
        expectSilentStop(result);
        expect(analyses()).toHaveLength(1);
        expect(
          withDb((db) => db.query('SELECT fingerprint FROM vortex_successful_analyses').all()),
        ).toEqual([]);
        expect(readLocks()).toEqual(scenario === 'expired' ? [] : locks);
      },
      20000,
    );

    it.each([
      ['finds issues', 'continue'],
      ['finds no issues', 'stop'],
      ['fails', 'failed'],
    ] as const)(
      'keeps the shared attempt count while another analysis runs, even when this analysis %s',
      async (_description, outcome) => {
        harness.cwd.writeFile('src/new.ts', BAD);
        if (outcome === 'stop') response.issues = [];
        if (outcome === 'failed') response.errors = [{ code: 'failure', message: 'Incomplete' }];
        const result = await whileAnalysisRuns(() => {
          const [lock] = readLocks();
          expect(lock).toMatchObject({ agent: 'claude', session_id: 'session' });
          expect(lock.lock_token).toBeString();
          const remaining = lock.lock_expires_at - Math.floor(Date.now() / 1000);
          expect(remaining).toBeGreaterThan(60);
          expect(remaining).toBeLessThanOrEqual(120);
          withDb((db) => {
            db.run('INSERT INTO vortex_analysis_locks VALUES (?, ?, ?, ?, ?)', [
              'another-fingerprint',
              'another-token',
              Math.floor(Date.now() / 1000) + 3600,
              'claude',
              'session',
            ]);
            db.run('UPDATE vortex_analysis_counters SET analysis_count = 2');
          });
        });
        expect(result.exitCode).toBe(0);
        if (outcome === 'continue') expect(JSON.parse(result.stdout).decision).toBe('block');
        else expectSilentStop(result);
        expect(queryState()).toEqual({
          count: 2,
          locks: 1,
          successful: outcome === 'failed' ? 0 : 1,
        });
        expect(readLocks()[0].fingerprint).toBe('another-fingerprint');
      },
      20000,
    );

    it('analyzes different file changes concurrently using separate locks and a shared attempt count', async () => {
      harness.cwd.writeFile('src/new.ts', BAD);
      await whileAnalysisRuns(async () => {
        const [first] = readLocks();
        harness.cwd.writeFile('src/new.ts', BAD + '// changed\n');
        response.beforeSqaaResponse = () => {
          const locks = readLocks();
          expect(locks).toHaveLength(2);
          expect(new Set(locks.map(({ lock_token }) => lock_token)).size).toBe(2);
          expect(readSessionCounters().session).toBe(2);
          return Promise.resolve();
        };
        const second = await invoke();
        expect(second.exitCode).toBe(0);
        expect(JSON.parse(second.stdout).decision).toBe('block');
        expect(queryState()).toEqual({ count: 2, locks: 1, successful: 1 });
        expect(readLocks()).toEqual([first]);
        harness.cwd.writeFile('src/new.ts', BAD);
      });
      expect(queryState()).toEqual({ count: 2, locks: 0, successful: 2 });
    }, 30000);

    it('discards results when files change during analysis', async () => {
      harness.cwd.writeFile('src/new.ts', BAD);
      const result = await whileAnalysisRuns(() => {
        harness.cwd.writeFile('src/new.ts', GOOD);
      });
      expectSilentStop(result);
      expect(analyses()).toHaveLength(1);
      expect(queryState()).toEqual({ count: 0, locks: 0, successful: 0 });
    }, 15000);

    it('runs only one analysis for simultaneous stops on the same files', async () => {
      harness.cwd.writeFile('src/new.ts', BAD);
      const first = await whileAnalysisRuns(async () => {
        const second = await invoke();
        expectSilentStop(second);
        expect(analyses()).toHaveLength(1);
        expect(queryState()).toEqual({ count: 1, locks: 1, successful: 0 });
      });
      expect(JSON.parse(first.stdout).decision).toBe('block');
      expect(queryState()).toEqual({ count: 1, locks: 0, successful: 1 });
    }, 30000);

    it('replaces an expired lock and rejects its late result', async () => {
      harness.cwd.writeFile('src/new.ts', BAD);
      const savedAt = Math.floor(Date.now() / 1000) + 3600;
      const first = await whileAnalysisRuns(async () => {
        withDb((db) => db.run('UPDATE vortex_analysis_locks SET lock_expires_at = 1'));
        const replacement = await invoke({ session_id: 'other' });
        expect(replacement.exitCode).toBe(0);
        expect(JSON.parse(replacement.stdout).decision).toBe('block');
        expect(queryState('other')).toEqual({ count: 1, locks: 0, successful: 1 });
        // A late failed run must not reset the replacement session's counter or overwrite its cache.
        withDb((db) => db.run('UPDATE vortex_successful_analyses SET analyzed_at = ?', [savedAt]));
      });
      expectSilentStop(first);
      expect(analyses()).toHaveLength(2);
      expect(queryState('other')).toEqual({ count: 1, locks: 0, successful: 1 });
      expect(
        withDb(
          (db) =>
            db
              .query<{ analyzed_at: number }, []>(
                'SELECT analyzed_at FROM vortex_successful_analyses',
              )
              .get()?.analyzed_at,
        ),
      ).toBe(savedAt);
    }, 30000);
  });

  describe('payloads and skipped analysis', () => {
    it('uses the payload working directory for Git and project discovery', async () => {
      harness.cwd.writeFile('src/new.ts', BAD);
      const result = await harness.runWithStdin(
        COMMAND,
        JSON.stringify({
          session_id: 'session',
          cwd: harness.cwd.path,
          hook_event_name: 'Stop',
        }),
        { cwd: harness.userHome.path },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).decision).toBe('block');
      expect(analyses()).toHaveLength(1);
    }, 15000);

    it('allows stopping without a connection', async () => {
      harness.state().clearAuth();
      harness.cwd.writeFile('src/new.ts', BAD);
      const result = await invoke();
      expectSilentStop(result);
      expect(analyses()).toHaveLength(0);
    }, 15000);

    it('allows stopping outside a Git repository', async () => {
      const result = await invoke({ cwd: harness.userHome.path });
      expectSilentStop(result);
      expect(analyses()).toHaveLength(0);
    }, 15000);

    it('allows stopping for an unknown agent', async () => {
      const result = await harness.runWithStdin('hook agent-stop --agent unknown', '{}');
      expectSilentStop(result);
      expect(analyses()).toHaveLength(0);
    }, 15000);

    it.each([403, 500])(
      'silently allows stopping when analysis returns HTTP %i',
      async (status) => {
        server = await harness
          .newFakeServer()
          .withAuthToken('test-token')
          .withSqaaStatusCode(status, 'Analysis unavailable')
          .start();
        harness.withAuth(server.baseUrl(), 'test-token', 'org');
        harness.cwd.writeFile('src/new.ts', BAD);
        const result = await invoke();
        expectSilentStop(result);
        expect(analyses()).toHaveLength(1);
        expect(queryState()).toEqual({ count: 0, locks: 0, successful: 0 });
      },
      15000,
    );

    it('allows stopping when no project is configured', async () => {
      git(['rm', 'sonar-project.properties'], harness.cwd.path);
      harness.cwd.writeFile('src/new.ts', BAD);
      const result = await invoke();
      expectSilentStop(result);
      expect(analyses()).toHaveLength(0);
    }, 15000);

    it('allows stopping with malformed JSON', async () => {
      const result = await harness.runWithStdin(COMMAND, 'not json');
      expectSilentStop(result);
      expect(analyses()).toHaveLength(0);
    }, 15000);
  });
});
