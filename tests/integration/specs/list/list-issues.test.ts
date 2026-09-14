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

// Integration tests for `list issues` via the compiled binary + fake SonarQube server

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

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
      harness.withAuth(server.baseUrl(), 'test-token');

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
      harness.withAuth(server.baseUrl(), 'test-token');

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

      harness.withAuth(server.baseUrl(), 'wrong-token');

      const result = await harness.run('list issues --project my-project');

      expect(result.exitCode).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'passes severity filter to API when --severities flag is provided',
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
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project --severities BLOCKER`);

      expect(result.exitCode).toBe(0);
      const recorded = server.getRecordedRequests();
      const issuesReq = recorded.find((r) => r.path === '/api/issues/search');
      expect(issuesReq?.query.severities).toBe('BLOCKER');
    },
    { timeout: 15000 },
  );

  it(
    'sends `components` query param to an on-premise server',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('my-token')
        .withProject('test-project')
        .start();
      harness.withAuth(server.baseUrl(), 'my-token');

      await harness.run(`list issues --project test-project`);

      const recorded = server.getRecordedRequests();
      const issuesRequest = recorded.find((r) => r.path === '/api/issues/search');

      expect(issuesRequest).toBeDefined();
      // On-premise SonarQube uses `components`; the fake server runs on localhost (non-cloud)
      expect(issuesRequest!.query.components).toBe('test-project');
      expect(issuesRequest!.query.projects).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'sends `componentKeys` query param to SonarQube Cloud',
    async () => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('my-token')
        .withProject('test-project')
        .start();
      harness.withAuth(server.baseUrl(), 'my-token');

      const result = await harness.run(`list issues --project test-project`);

      expect(result.exitCode).toBe(0);
      const issuesRequest = server
        .getRecordedRequests()
        .find((r) => r.path === '/api/issues/search');

      expect(issuesRequest).toBeDefined();
      expect(issuesRequest!.query.componentKeys).toBe('test-project');
      expect(issuesRequest!.query.components).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it.each([
    [
      'a file path',
      'src/foo.ts',
      'my-project:src/foo.ts',
      [{ path: 'src/foo.ts', qualifier: 'FIL' }],
    ],
    ['a directory path', 'src/api', 'my-project:src/api', [{ path: 'src/api', qualifier: 'DIR' }]],
    [
      "a leading './'",
      './src/foo.ts',
      'my-project:src/foo.ts',
      [{ path: 'src/foo.ts', qualifier: 'FIL' }],
    ],
    [
      "a leading '/'",
      '/src/foo.ts',
      'my-project:src/foo.ts',
      [{ path: 'src/foo.ts', qualifier: 'FIL' }],
    ],
    [
      "a shell-completed trailing '/'",
      'src/api/',
      'my-project:src/api',
      [{ path: 'src/api', qualifier: 'DIR' }],
    ],
    [
      "a shell-completed trailing '/' on a root-level directory (ambiguous by name alone)",
      'src/',
      'my-project:src',
      [
        { path: 'src', qualifier: 'DIR' },
        { path: 'src-gen', qualifier: 'DIR' },
      ],
    ],
    [
      "Windows '\\' separators",
      'src\\foo.ts',
      'my-project:src/foo.ts',
      [{ path: 'src/foo.ts', qualifier: 'FIL' }],
    ],
  ] as const)(
    'resolves --file and composes the components param when given %s',
    async (_name, file, expectedComponentKey, treeItems) => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) => p.withComponentsTreeItems([...treeItems]))
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project --file ${file}`);

      expect(result.exitCode).toBe(0);
      const issuesReq = server.getRecordedRequests().find((r) => r.path === '/api/issues/search');
      expect(issuesReq?.query.components).toBe(expectedComponentKey);
    },
    { timeout: 15000 },
  );

  it(
    'forwards --branch to /api/components/tree when resolving --file by name alone',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withComponentsTreeItems([{ path: 'src/foo.ts', qualifier: 'FIL' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `list issues --project my-project --file foo.ts --branch feature-x`,
      );

      expect(result.exitCode).toBe(0);
      const treeReq = server.getRecordedRequests().find((r) => r.path === '/api/components/tree');
      expect(treeReq?.query.branch).toBe('feature-x');
    },
    { timeout: 15000 },
  );

  it(
    'forwards --pull-request to /api/components/show when resolving --file by full path',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withComponentsTreeItems([{ path: 'src/foo.ts', qualifier: 'FIL' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        `list issues --project my-project --file src/foo.ts --pull-request 42`,
      );

      expect(result.exitCode).toBe(0);
      const showReq = server.getRecordedRequests().find((r) => r.path === '/api/components/show');
      expect(showReq?.query.pullRequest).toBe('42');
    },
    { timeout: 15000 },
  );

  it(
    'resolves --file to its full path when given just a filename with a unique match',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withComponentsTreeItems([
            { path: 'src/commands/foo.ts', qualifier: 'FIL' },
            { path: 'src/commands/bar.ts', qualifier: 'FIL' },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project --file foo.ts`);

      expect(result.exitCode).toBe(0);
      const issuesReq = server.getRecordedRequests().find((r) => r.path === '/api/issues/search');
      expect(issuesReq?.query.components).toBe('my-project:src/commands/foo.ts');
    },
    { timeout: 15000 },
  );

  it(
    'resolves --file to a test file when given just its filename (SonarQube qualifies test files as UTS, not FIL)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withComponentsTreeItems([
            { path: 'tests/unit/commands/foo.test.ts', qualifier: 'UTS' },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project --file foo.test.ts`);

      expect(result.exitCode).toBe(0);
      const issuesReq = server.getRecordedRequests().find((r) => r.path === '/api/issues/search');
      expect(issuesReq?.query.components).toBe('my-project:tests/unit/commands/foo.test.ts');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --file matches multiple files or directories',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withComponentsTreeItems([
            { path: 'src/commands/foo.ts', qualifier: 'FIL' },
            { path: 'src/core/foo.ts', qualifier: 'FIL' },
          ]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project --file foo.ts`);

      expect(result.exitCode).toBe(2);
      const output = result.stdout + result.stderr;
      expect(output).toContain("'foo.ts' matches 2 files or directories");
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --file matches no file or directory',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withComponentsTreeItems([{ path: 'src/commands/foo.ts', qualifier: 'FIL' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project --file missing.ts`);

      expect(result.exitCode).toBe(2);
      const output = result.stdout + result.stderr;
      expect(output).toContain("No file or directory matching 'missing.ts' was found");
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --file is a full path that does not exactly match, despite a same-named file elsewhere',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withComponentsTreeItems([{ path: 'src/commands/foo.ts', qualifier: 'FIL' }]),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project --file src/wrong/foo.ts`);

      expect(result.exitCode).toBe(2);
      const output = result.stdout + result.stderr;
      expect(output).toContain("No file or directory matching 'src/wrong/foo.ts' was found");
    },
    { timeout: 15000 },
  );

  it(
    'returns only issues scoped to the given file when --file is provided',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withComponentsTreeItems([{ path: 'src/foo.ts', qualifier: 'FIL' }])
            .withIssue({
              ruleKey: 'java:S1234',
              message: 'Scoped issue',
              severity: 'MAJOR',
              component: 'my-project:src/foo.ts',
            })
            .withIssue({
              ruleKey: 'java:S5678',
              message: 'Other file issue',
              severity: 'CRITICAL',
              component: 'my-project:src/bar.ts',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project --file src/foo.ts`);

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0].message).toBe('Scoped issue');
    },
    { timeout: 15000 },
  );

  it(
    'returns only issues scoped to the given file when --file is provided on SonarQube Cloud',
    async () => {
      const server = await harness
        .newFakeServer()
        .asSonarCloud()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withComponentsTreeItems([{ path: 'src/foo.ts', qualifier: 'FIL' }])
            .withIssue({
              ruleKey: 'java:S1234',
              message: 'Scoped issue',
              severity: 'MAJOR',
              component: 'my-project:src/foo.ts',
            })
            .withIssue({
              ruleKey: 'java:S5678',
              message: 'Other file issue',
              severity: 'CRITICAL',
              component: 'my-project:src/bar.ts',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project --file src/foo.ts`);

      expect(result.exitCode).toBe(0);
      const issuesReq = server.getRecordedRequests().find((r) => r.path === '/api/issues/search');
      expect(issuesReq?.query.componentKeys).toBe('my-project:src/foo.ts');
      const parsed = JSON.parse(result.stdout);
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0].message).toBe('Scoped issue');
    },
    { timeout: 15000 },
  );

  it(
    'returns issues on the direct children of a directory but not its nested subdirectories',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withComponentsTreeItems([{ path: 'src/api', qualifier: 'DIR' }])
            .withIssue({
              ruleKey: 'java:S1234',
              message: 'Issue directly in the directory',
              severity: 'MAJOR',
              component: 'my-project:src/api/handler.ts',
            })
            .withIssue({
              ruleKey: 'java:S4321',
              message: 'Issue in a nested subdirectory',
              severity: 'MAJOR',
              component: 'my-project:src/api/internal/parser.ts',
            })
            .withIssue({
              ruleKey: 'java:S5678',
              message: 'Issue in a sibling directory',
              severity: 'CRITICAL',
              component: 'my-project:src/web/controller.ts',
            }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(`list issues --project my-project --file src/api`);

      // Known limitation: componentKeys never recurses into subdirectories , so only the direct
      // child's issue comes back.
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.issues.map((i: { message: string }) => i.message)).toEqual([
        'Issue directly in the directory',
      ]);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and prompts to authenticate when no auth is configured',
    async () => {
      // --project must be supplied so Commander passes control to authenticated()
      const result = await harness.run('list issues --project my-project');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Not authenticated.');
      expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when --project is missing',
    async () => {
      // Commander enforces the requiredOption before the action handler runs — no auth needed
      const result = await harness.run('list issues');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "❌ error: required option '-p, --project <project>' not specified",
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when server is unreachable',
    async () => {
      harness.withAuth('http://127.0.0.1:19999', 'test-token');

      const result = await harness.run('list issues --project my-project', { timeoutMs: 10000 });

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
      harness.withAuth(server.baseUrl(), 'tok');

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
      // Commander rejects non-integer before the action handler runs — no auth needed
      const result = await harness.run('list issues --project my-project --page-size abc');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "❌ error: option '--page-size <page-size>' argument 'abc' is invalid. Not a number.",
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --page-size is less than 1',
    async () => {
      // Validation runs inside the handler — auth must pass first
      harness.withAuth('http://localhost:19999', 'fake-token');

      const result = await harness.run('list issues --project my-project --page-size 0');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain(
        "Invalid --page-size option: '0'. Must be an integer between 1 and 500",
      );
    },
    { timeout: 15000 },
  );

  it.each([
    [
      '--page-size is greater than 500',
      'list issues --project my-project --page-size 501',
      'Invalid --page-size',
    ],
    [
      '--severities is not a recognised value',
      'list issues --project my-project --severities UNKNOWN',
      'Invalid severity',
    ],
    [
      '--statuses is not a recognised value',
      'list issues --project my-project --statuses UNKNOWN',
      'Invalid status(es)',
    ],
  ])(
    'exits with code 2 when %s',
    async (_, command, expectedError) => {
      // Validation runs inside the handler — auth must pass first
      harness.withAuth('http://localhost:19999', 'fake-token');

      const result = await harness.run(command);

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain(expectedError);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when --format is not a recognised value',
    async () => {
      // Validation runs inside the handler — auth must pass first
      harness.withAuth('http://localhost:19999', 'fake-token');

      const result = await harness.run('list issues --project my-project --format xml');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "error: option '--format <format>' argument 'xml' is invalid. Allowed choices are json, toon, table, csv.",
      );
    },
    { timeout: 15000 },
  );

  it(
    'sends impactSeverities param on MQR server',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMode('MQR')
        .withProject('my-project', (p) =>
          p.withIssue({ ruleKey: 'java:S1234', message: 'An issue', severity: 'MAJOR' }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run('list issues --project my-project --severities HIGH,MEDIUM');

      expect(result.exitCode).toBe(0);
      const recorded = server.getRecordedRequests();
      const issuesReq = recorded.find((r) => r.path === '/api/issues/search');
      expect(issuesReq?.query.impactSeverities).toBe('HIGH,MEDIUM');
      expect(issuesReq?.query.severities).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when Standard-only value is used on MQR server',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMode('MQR')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run('list issues --project my-project --severities MAJOR');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('Invalid severity');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when MQR-only value is used on Standard server',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withMode('STANDARD')
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run('list issues --project my-project --severities HIGH');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('Invalid severity');
    },
    { timeout: 15000 },
  );

  it(
    'passes multiple severities to API when --severities is provided with multiple values',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p
            .withIssue({ ruleKey: 'java:S1234', message: 'Major issue', severity: 'MAJOR' })
            .withIssue({ ruleKey: 'java:S9999', message: 'Critical issue', severity: 'CRITICAL' })
            .withIssue({ ruleKey: 'java:S9999', message: 'Blocker issue', severity: 'BLOCKER' }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run(
        'list issues --project my-project --severities MAJOR,CRITICAL',
      );

      expect(result.exitCode).toBe(0);
      const recorded = server.getRecordedRequests();
      const issuesReq = recorded.find((r) => r.path === '/api/issues/search');
      expect(issuesReq?.query.severities).toBe('MAJOR,CRITICAL');
      expect(result.stdout).toContain('"total": 2');
    },
    { timeout: 15000 },
  );

  it(
    'passes single severity to API when --severities is provided with a single value',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('test-token')
        .withProject('my-project', (p) =>
          p.withIssue({ ruleKey: 'java:S1234', message: 'Major issue', severity: 'MAJOR' }),
        )
        .start();
      harness.withAuth(server.baseUrl(), 'test-token');

      const result = await harness.run('list issues --project my-project --severities MAJOR');

      expect(result.exitCode).toBe(0);
      const recorded = server.getRecordedRequests();
      const issuesReq = recorded.find((r) => r.path === '/api/issues/search');
      expect(issuesReq?.query.severities).toBe('MAJOR');
      expect(result.stdout).toContain('"total": 1');
    },
    { timeout: 15000 },
  );

  it('passes multiple statuses to API when --statuses is provided with multiple values', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('my-project', (p) =>
        p
          .withIssue({
            ruleKey: 'java:S1234',
            message: 'Major issue',
            severity: 'MAJOR',
            status: 'OPEN',
          })
          .withIssue({
            ruleKey: 'java:S9999',
            message: 'Blocker issue',
            severity: 'BLOCKER',
            status: 'FIXED',
          })
          .withIssue({
            ruleKey: 'java:S9999',
            message: 'Blocker issue',
            severity: 'BLOCKER',
            status: 'FALSE_POSITIVE',
          }),
      )
      .start();
    harness.withAuth(server.baseUrl(), 'test-token');

    const result = await harness.run('list issues --project my-project --statuses OPEN,FIXED');

    expect(result.exitCode).toBe(0);
    const recorded = server.getRecordedRequests();
    const issuesReq = recorded.find((r) => r.path === '/api/issues/search');
    expect(issuesReq?.query.issueStatuses).toBe('OPEN,FIXED');
    expect(result.stdout).toContain('"total": 2');
  });

  it('passes single status to API when --statuses is provided with a single value', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('my-project', (p) =>
        p
          .withIssue({
            ruleKey: 'java:S1234',
            message: 'Major issue',
            severity: 'MAJOR',
            status: 'OPEN',
          })
          .withIssue({
            ruleKey: 'java:S9999',
            message: 'Blocker issue',
            severity: 'BLOCKER',
            status: 'FIXED',
          })
          .withIssue({
            ruleKey: 'java:S9999',
            message: 'Blocker issue',
            severity: 'BLOCKER',
            status: 'FALSE_POSITIVE',
          }),
      )
      .start();
    harness.withAuth(server.baseUrl(), 'test-token');

    const result = await harness.run('list issues --project my-project --statuses open');

    expect(result.exitCode).toBe(0);
    const recorded = server.getRecordedRequests();
    const issuesReq = recorded.find((r) => r.path === '/api/issues/search');
    expect(issuesReq?.query.issueStatuses).toBe('OPEN');
    expect(result.stdout).toContain('"total": 1');
  });

  it('defaults to OPEN,CONFIRMED statuses when --statuses is not provided', async () => {
    const server = await harness
      .newFakeServer()
      .withAuthToken('test-token')
      .withProject('my-project', (p) =>
        p
          .withIssue({
            ruleKey: 'java:S1111',
            message: 'Open issue',
            severity: 'MAJOR',
            status: 'OPEN',
          })
          .withIssue({
            ruleKey: 'java:S2222',
            message: 'Confirmed issue',
            severity: 'MAJOR',
            status: 'CONFIRMED',
          })
          .withIssue({
            ruleKey: 'java:S3333',
            message: 'Fixed issue',
            severity: 'BLOCKER',
            status: 'FIXED',
          })
          .withIssue({
            ruleKey: 'java:S4444',
            message: 'False positive issue',
            severity: 'BLOCKER',
            status: 'FALSE_POSITIVE',
          })
          .withIssue({
            ruleKey: 'java:S5555',
            message: 'Accepted issue',
            severity: 'BLOCKER',
            status: 'ACCEPTED',
          }),
      )
      .start();
    harness.withAuth(server.baseUrl(), 'test-token');

    const result = await harness.run('list issues --project my-project');

    expect(result.exitCode).toBe(0);
    const recorded = server.getRecordedRequests();
    const issuesReq = recorded.find((r) => r.path === '/api/issues/search');
    expect(issuesReq?.query.issueStatuses).toBe('OPEN,CONFIRMED');
    expect(result.stdout).toContain('"total": 2');
    expect(result.stdout).toContain('java:S1111');
    expect(result.stdout).toContain('java:S2222');
    expect(result.stdout).not.toContain('java:S3333');
    expect(result.stdout).not.toContain('java:S4444');
    expect(result.stdout).not.toContain('java:S5555');
  });
});
