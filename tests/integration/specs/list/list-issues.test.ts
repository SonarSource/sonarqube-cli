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

// Integration tests for `list issues` via the compiled binary + fake SonarQube server

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { TestHarness } from '../../harness';

describe('list issues', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'returns issues from fake server',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withIssue({ ruleKey: 'java:S1234', message: 'Fix this', severity: 'MAJOR' })
            .withIssue({ ruleKey: 'java:S5678', message: 'Another issue', severity: 'CRITICAL' }),
        )
        .start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('java:S1234');
      expect(result.stdout).toContain('java:S5678');
      expect(result.stdout).toContain('Fix this');
    },
    { timeout: 15000 },
  );

  it(
    'returns empty issues list when project has no issues',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('empty-project')
        .start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project empty-project`);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.issues).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when token is invalid',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withProject('my-project')
        .start();

      const result = await harness.run(
        `list issues --project my-project --server ${server.baseUrl()} --token wrong-token`,
      );

      expect(result.exitCode).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'passes severity filter to API when --severity flag is provided',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withIssue({ ruleKey: 'java:S1234', message: 'Major issue', severity: 'MAJOR' })
            .withIssue({ ruleKey: 'java:S9999', message: 'Blocker issue', severity: 'BLOCKER' }),
        )
        .start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project --severity BLOCKER`);

      expect(result.exitCode).toBe(0);
      const recorded = server.getRecordedRequests();
      const issuesReq = recorded.find((r) => r.path === '/api/issues/search');
      expect(issuesReq?.query.severities).toBe('BLOCKER');
    },
    { timeout: 15000 },
  );

  it(
    'records the HTTP request sent to the fake server',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withProject('test-project')
        .start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'my-token');

      await harness.run(`list issues --project test-project`);

      const recorded = server.getRecordedRequests();
      const issuesRequest = recorded.find((r) => r.path === '/api/issues/search');

      expect(issuesRequest).toBeDefined();
      expect(issuesRequest!.query.projects).toBe('test-project');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when --project is missing',
    async () => {
      const result = await harness.run(
        'list issues --server http://localhost:9999 --token test-token',
      );

      expect(result.exitCode).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when server is unreachable',
    async () => {
      const result = await harness.run(
        'list issues --project my-project --server http://127.0.0.1:19999 --token test-token',
        { timeoutMs: 10000 },
      );

      expect(result.exitCode).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'outputs valid JSON with issues array',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('tok')
        .withProject('proj', (p) =>
          p.withIssue({ ruleKey: 'ts:S1000', message: 'TypeScript issue', severity: 'MINOR' }),
        )
        .start();
      harness
        .state()
        .withActiveConnection(server.baseUrl())
        .withKeychainToken(server.baseUrl(), 'tok');

      const result = await harness.run(`list issues --project proj`);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(Array.isArray(parsed.issues)).toBe(true);
      expect(parsed.issues[0].rule).toBe('ts:S1000');
      expect(parsed.issues[0].message).toBe('TypeScript issue');
    },
    { timeout: 15000 },
  );
});

describe('list issues — argument validation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 when --page-size is not a number',
    async () => {
      const result = await harness.run('list issues --project my-project --page-size abc');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "error: option '--page-size <page-size>' argument 'abc' is invalid. Not a number.",
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when --page-size is less than 1',
    async () => {
      const result = await harness.run('list issues --project my-project --page-size 0');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "Invalid --page-size option: '0'. Must be an integer between 1 and 500",
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when --page-size is greater than 500',
    async () => {
      const result = await harness.run('list issues --project my-project --page-size 501');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Invalid --page-size');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when --format is not a recognised value',
    async () => {
      const result = await harness.run('list issues --project my-project --format xml');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Invalid format');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when --severity is not a recognised value',
    async () => {
      const result = await harness.run('list issues --project my-project --severity UNKNOWN');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Invalid severity');
    },
    { timeout: 15000 },
  );
});
