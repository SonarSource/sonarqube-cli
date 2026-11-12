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

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

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
      return {
        count: db
          .query<{ analysis_count: number }, [string]>(
            'SELECT analysis_count FROM vortex_analysis_counters WHERE session_id = ?',
          )
          .get(sessionId)?.analysis_count,
        locks: db
          .query<{ count: number }, []>('SELECT count(*) AS count FROM vortex_analysis_locks')
          .get()?.count,
        successful: db
          .query<{ count: number }, []>('SELECT count(*) AS count FROM vortex_successful_analyses')
          .get()?.count,
      };
    });
  }

  it('retries unchanged files after analysis fails', async () => {
    harness.cwd.writeFile('src/new.ts', BAD);
    response.errors = [{ code: 'failure', message: 'Analysis incomplete' }];
    expect((await invoke()).stdout.trim()).toBe('');
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
    expect(other.exitCode).toBe(0);
    expect(other.stdout.trim()).toBe('');
    expect(analyses()).toHaveLength(1);
    expect(queryState()).toEqual({ count: 1, locks: 0, successful: 1 });
    expect(queryState('other').count).toBeUndefined();
  }, 30000);

  it('keeps session counters and resets separate', async () => {
    harness.cwd.writeFile('src/new.ts', BAD);
    await invoke();
    harness.cwd.writeFile('src/new.ts', BAD + '// another change\n');
    await invoke({ session_id: 'other' });
    expect(queryState().count).toBe(1);
    expect(queryState('other').count).toBe(1);
    await invoke({ session_id: 'other' });
    expect(queryState('other').count).toBe(0);
    expect(queryState().count).toBe(1);
    harness.cwd.writeFile('src/new.ts', BAD + '// third change\n');
    expect(JSON.parse((await invoke()).stdout).decision).toBe('block');
    expect(queryState().count).toBe(2);
    expect(queryState('other').count).toBe(0);
    expect(analyses()).toHaveLength(3);
  }, 30000);

  it('removes expired saved results and abandoned counters', async () => {
    harness.cwd.writeFile('src/new.ts', BAD);
    await invoke();
    withDb((db) => {
      db.run('UPDATE vortex_successful_analyses SET analyzed_at = 1');
      db.run('UPDATE vortex_analysis_counters SET updated_at = 1');
      db.run('INSERT INTO vortex_analysis_counters VALUES (?, ?, ?, ?)', [
        'claude',
        'abandoned',
        3,
        1,
      ]);
    });
    expect(JSON.parse((await invoke()).stdout).decision).toBe('block');
    expect(analyses()).toHaveLength(2);
    expect(queryState()).toEqual({ count: 1, locks: 0, successful: 1 });
    expect(queryState('abandoned').count).toBeUndefined();
  }, 30000);

  it('discards results when files change during analysis', async () => {
    harness.cwd.writeFile('src/new.ts', BAD);
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
      harness.cwd.writeFile('src/new.ts', GOOD);
    } finally {
      release.resolve();
      await running;
    }
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(analyses()).toHaveLength(1);
    expect(queryState()).toEqual({ count: 0, locks: 0, successful: 0 });
  }, 15000);

  it('runs only one analysis for simultaneous stops on the same files', async () => {
    harness.cwd.writeFile('src/new.ts', BAD);
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    response.beforeSqaaResponse = async () => {
      received.resolve();
      await release.promise;
    };
    const first = invoke();
    try {
      await Promise.race([
        received.promise,
        first.then(() => {
          throw new Error('Analysis did not start');
        }),
      ]);
      const second = await invoke();
      expect(second.exitCode).toBe(0);
      expect(second.stdout.trim()).toBe('');
      expect(analyses()).toHaveLength(1);
      expect(queryState()).toEqual({ count: 1, locks: 1, successful: 0 });
    } finally {
      release.resolve();
      await first;
    }
    expect(JSON.parse((await first).stdout).decision).toBe('block');
    expect(queryState()).toEqual({ count: 1, locks: 0, successful: 1 });
  }, 30000);

  it('replaces an expired lock and rejects its late result', async () => {
    harness.cwd.writeFile('src/new.ts', BAD);
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const savedAt = Math.floor(Date.now() / 1000) + 3600;
    response.beforeSqaaResponse = async () => {
      received.resolve();
      await release.promise;
    };
    const first = invoke();
    try {
      await Promise.race([
        received.promise,
        first.then(() => {
          throw new Error('Analysis did not start');
        }),
      ]);
      withDb((db) => db.run('UPDATE vortex_analysis_locks SET lock_expires_at = 1'));
      response.beforeSqaaResponse = undefined;
      const replacement = await invoke({ session_id: 'other' });
      expect(replacement.exitCode).toBe(0);
      expect(JSON.parse(replacement.stdout).decision).toBe('block');
      expect(queryState('other')).toEqual({ count: 1, locks: 0, successful: 1 });
      // A late failed run must not reset the replacement session's counter or overwrite its cache.
      withDb((db) => db.run('UPDATE vortex_successful_analyses SET analyzed_at = ?', [savedAt]));
    } finally {
      release.resolve();
      await first;
    }
    expect((await first).stdout.trim()).toBe('');
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
    expect(second.exitCode).toBe(0);
    expect(second.stdout.trim()).toBe('');
    expect(analyses()).toHaveLength(2);
    expect(queryState()).toEqual({ count: 0, locks: 0, successful: 2 });
    expect((await invoke()).stdout.trim()).toBe('');
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

  it('skips a fingerprint while another analysis owns its lock', async () => {
    harness.cwd.writeFile('src/new.ts', BAD);
    await invoke();
    const db = new Database(harness.cliHome.file('db/hooks/stop-hook-vortex-analysis.db').path);
    try {
      const saved = db
        .query<{ fingerprint: string }, []>('SELECT fingerprint FROM vortex_successful_analyses')
        .get();
      expect(saved).not.toBeNull();
      db.run('DELETE FROM vortex_successful_analyses');
      db.run('INSERT INTO vortex_analysis_locks VALUES (?, ?, ?, ?, ?)', [
        saved?.fingerprint ?? '',
        'other-owner',
        Math.floor(Date.now() / 1000) + 120,
        'claude',
        'session',
      ]);
    } finally {
      db.close();
    }
    const result = await invoke();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(analyses()).toHaveLength(1);
    expect(queryState()).toEqual({ count: 1, locks: 1, successful: 0 });
  }, 20000);

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

  it('clears the counter and lock when there are no files to analyze', async () => {
    const result = await invoke();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(analyses()).toHaveLength(0);
    expect(queryState()).toEqual({ count: 0, locks: 0, successful: 0 });
  }, 15000);
  it('allows stopping when storage is corrupt', async () => {
    harness.cwd.writeFile('src/new.ts', BAD);
    harness.cliHome.writeFile('db/hooks/stop-hook-vortex-analysis.db', 'corrupt database');
    const result = await invoke();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(analyses()).toHaveLength(0);
  }, 15000);

  it('allows stopping without a connection', async () => {
    harness.state().clearAuth();
    harness.cwd.writeFile('src/new.ts', BAD);
    const result = await invoke();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(analyses()).toHaveLength(0);
  }, 15000);

  it('allows stopping outside a Git repository', async () => {
    const result = await invoke({ cwd: harness.userHome.path });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(analyses()).toHaveLength(0);
  }, 15000);

  it('allows stopping for an unknown agent', async () => {
    const result = await harness.runWithStdin('hook agent-stop --agent unknown', '{}');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
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
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      expect(analyses()).toHaveLength(1);
      expect(queryState()).toEqual({ count: 0, locks: 0, successful: 0 });
    },
    15000,
  );

  it('does not request fixes when saving a successful analysis fails', async () => {
    harness.cwd.writeFile('src/new.ts', GOOD);
    response.issues = [];
    await invoke();
    const db = new Database(harness.cliHome.file('db/hooks/stop-hook-vortex-analysis.db').path);
    try {
      db.run(`CREATE TRIGGER fail_completion BEFORE INSERT ON vortex_successful_analyses
        BEGIN SELECT RAISE(ABORT, 'Test write failure'); END`);
    } finally {
      db.close();
    }
    harness.cwd.writeFile('src/new.ts', BAD);
    response.issues = [{ ...ISSUE }];
    const result = await invoke();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(analyses()).toHaveLength(2);
    expect(queryState()).toEqual({ count: 1, locks: 1, successful: 1 });
  }, 20000);

  it('does not save partial analysis results', async () => {
    harness.cwd.writeFile('src/new.ts', BAD);
    response.errors = [{ code: 'failure', message: 'Analysis incomplete' }];
    const result = await invoke();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(queryState()).toEqual({ count: 0, locks: 0, successful: 0 });
  }, 15000);

  it('allows stopping when no project is configured', async () => {
    git(['rm', 'sonar-project.properties'], harness.cwd.path);
    harness.cwd.writeFile('src/new.ts', BAD);
    const result = await invoke();
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(analyses()).toHaveLength(0);
  }, 15000);

  it('allows stopping with malformed JSON', async () => {
    const result = await harness.runWithStdin(COMMAND, 'not json');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
    expect(analyses()).toHaveLength(0);
  }, 15000);
});
