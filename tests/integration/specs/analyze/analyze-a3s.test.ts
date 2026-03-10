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

// Integration tests for `analyze a3s` and `analyze` (full pipeline).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestHarness } from '../../harness';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';

describe('analyze a3s', () => {
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
      const result = await harness.run('analyze a3s --file nonexistent.ts');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('File not found');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and skips silently when no active connection',
    async () => {
      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze a3s --file src/index.ts');

      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and skips A3S for on-premise server',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      harness
        .state()
        .withActiveConnection(server.baseUrl(), 'on-premise')
        .withKeychainToken(server.baseUrl(), VALID_TOKEN);

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze a3s --file src/index.ts');

      expect(result.exitCode).toBe(0);
      // A3S is SonarCloud-only — should not call A3S endpoint
      const a3sCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(a3sCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and skips A3S when no extension registered for this project',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withA3sResponse({ issues: [] })
        .start();

      // Connection exists but no withA3sExtension() → no projectKey in registry → skip
      harness
        .state()
        .withActiveConnection(server.baseUrl(), 'cloud', TEST_ORG)
        .withKeychainToken(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze a3s --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const a3sCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(a3sCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'calls A3S API and reports no issues found for clean file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withA3sResponse({ issues: [] })
        .start();

      harness
        .state()
        .withActiveConnection(server.baseUrl(), 'cloud', TEST_ORG)
        .withKeychainToken(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withA3sExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze a3s --file src/index.ts');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('no issues found');
      const a3sCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(a3sCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'calls A3S API and displays found issues with line numbers',
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
        .withActiveConnection(server.baseUrl(), 'cloud', TEST_ORG)
        .withKeychainToken(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withA3sExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('main.py', 'def foo():\n  pass\n');

      const result = await harness.run('analyze a3s --file main.py');

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
    'calls A3S API and displays API-level errors',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withA3sResponse({
          issues: [],
          errors: [{ code: 'NOT_ENTITLED', message: 'Organization is not entitled to A3S' }],
        })
        .start();

      harness
        .state()
        .withActiveConnection(server.baseUrl(), 'cloud', TEST_ORG)
        .withKeychainToken(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withA3sExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze a3s --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('NOT_ENTITLED');
      expect(output).toContain('not entitled');
    },
    { timeout: 15000 },
  );
});

describe('analyze (full pipeline)', () => {
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
      const result = await harness.run('analyze --file nonexistent.ts');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('File not found');
    },
    { timeout: 15000 },
  );

  it(
    'warns and returns early when secrets are detected in the file',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withActiveConnection(server.baseUrl(), 'cloud', TEST_ORG)
        .withKeychainToken(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      harness.cwd.writeFile('config.ts', `const token = "${GITHUB_TEST_TOKEN}";`);

      const result = await harness.run('analyze --file config.ts');

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Secrets detected');
    },
    { timeout: 30000 },
  );

  it(
    'skips secrets scan and runs A3S when binary is not installed',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withA3sResponse({ issues: [] })
        .start();

      harness
        .state()
        .withActiveConnection(server.baseUrl(), 'cloud', TEST_ORG)
        .withKeychainToken(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withA3sExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      // No withSecretsBinaryInstalled() → secrets scan skipped
      const result = await harness.run('analyze --file src/index.ts');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('no issues found');
      const a3sCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(a3sCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'runs both secrets scan and A3S when binary is installed and file is clean',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withA3sResponse({
          issues: [{ rule: 'js:S1234', message: 'Fix this' }],
        })
        .start();

      harness
        .state()
        .withSecretsBinaryInstalled()
        .withActiveConnection(server.baseUrl(), 'cloud', TEST_ORG)
        .withKeychainToken(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withA3sExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const greeting = "hello world";');

      const result = await harness.run('analyze --file src/index.ts');

      expect(result.exitCode).toBe(0);
      const output = result.stdout + result.stderr;
      // Secrets scan passes, then A3S runs and finds an issue
      expect(output).toContain('Fix this');
      const a3sCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(a3sCalls).toHaveLength(1);
    },
    { timeout: 30000 },
  );
});
