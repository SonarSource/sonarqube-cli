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

// Integration tests for `analyze sqaa` and `verify` commands.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestHarness } from '../../harness';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';

describe('analyze (no subcommand)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 0 and displays help with subcommands listed',
    async () => {
      const result = await harness.run('analyze');

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('secrets');
      expect(output).toContain('sqaa');
    },
    { timeout: 15000 },
  );
});

describe('analyze sqaa', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 when file does not exist',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze sqaa --file nonexistent.ts');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('File not found');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and prompts to authenticate when no active connection',
    async () => {
      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        '❌ Not authenticated. Run: sonar auth login',
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and skips SQAA for on-premise server',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN);

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts');

      expect(result.exitCode).toBe(0);
      // SQAA is SonarCloud-only — should not call SQAA endpoint
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and skips SQAA when no extension registered for this project',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withA3sResponse({ issues: [] })
        .start();

      // Connection exists but no withA3sExtension() → no projectKey in registry → skip
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'calls SQAA API and reports no issues found for clean file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withA3sResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withA3sExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('no issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'calls SQAA API and displays found issues with line numbers',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withA3sResponse({
          issues: [
            { rule: 'python:S1234', message: 'Refactor this method', startLine: 5 },
            { rule: 'python:S5678', message: 'Remove this unused variable' },
          ],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withA3sExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('main.py', 'def foo():\n  pass\n');

      const result = await harness.run('analyze sqaa --file main.py');

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('2 issues');
      expect(output).toContain('Refactor this method');
      expect(output).toContain('line 5');
      expect(output).toContain('python:S1234');
    },
    { timeout: 15000 },
  );

  it(
    'calls SQAA API and displays API-level errors',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withA3sResponse({
          issues: [],
          errors: [{ code: 'NOT_ENTITLED', message: 'Organization is not entitled to SQAA' }],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withA3sExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('NOT_ENTITLED');
      expect(output).toContain('not entitled');
    },
    { timeout: 15000 },
  );
});

describe('verify', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 when file does not exist',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('verify --file nonexistent.ts');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('File not found');
    },
    { timeout: 15000 },
  );

  it(
    'calls SQAA API and reports no issues found for clean file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withA3sResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withA3sExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('verify --file src/index.ts');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('no issues found');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );
});
