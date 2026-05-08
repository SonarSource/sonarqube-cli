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

// Integration tests for `analyze sqaa` and `verify` commands.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';
import { commitFile, git, initGitRepo, stageFile } from '../hook/git-test-helpers';

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
    'exits with code 2 when file does not exist',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('analyze sqaa --file nonexistent.ts');

      expect(result.exitCode).toBe(2);
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
    'exits with code 0, warns, and skips SQAA for on-premise server',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN);

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'SonarQube Agentic Analysis skipped: a SonarQube Cloud connection is required. Run: sonar auth login (ensure you connect to SonarQube Cloud)',
      );
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0, warns, and skips SQAA when no extension registered for this project',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      // Connection exists but no withSqaaExtension() → no projectKey in registry → skip
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'SonarQube Agentic Analysis skipped: no project configured. Specify one with --project or run: sonar integrate claude',
      );
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'calls SQAA API when --project and --branch are provided (bypasses extension registry)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      // Cloud auth only — no extension registered; --project + --branch bypass registry lookup
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run(
        `analyze sqaa --file src/index.ts --project ${TEST_PROJECT} --branch main`,
      );

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
    'calls SQAA API and reports no issues found for clean file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

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
        .withSqaaResponse({
          issues: [
            { rule: 'python:S1234', message: 'Refactor this method', startLine: 5 },
            { rule: 'python:S5678', message: 'Remove this unused variable' },
          ],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('main.py', 'def foo():\n  pass\n');

      const result = await harness.run('analyze sqaa --file main.py');

      expect(result.exitCode).toBe(51);
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
        .withSqaaResponse({
          issues: [],
          errors: [{ code: 'NOT_ENTITLED', message: 'Organization is not entitled to SQAA' }],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

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

describe('analyze sqaa — change-set mode (no --file)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    // All change-set tests need a real git repo in cwd.
    initGitRepo(harness.cwd.path);
    // Ignore harness-internal files the CLI binary may create in cwd (e.g. .claude/).
    commitFile(harness.cwd.path, '.gitignore', '.claude/\n');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 0 and reports no files when change set is empty',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      // Empty repo: first commit with no changes after it.
      commitFile(harness.cwd.path, 'README.md', 'hello');

      const result = await harness.run('analyze sqaa');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('no files in the change set');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'default mode: analyzes unstaged modified files vs HEAD',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'app.ts', 'const a = 1;');
      // Modify without staging — should appear in `git diff HEAD`
      harness.cwd.writeFile('app.ts', 'const a = 2;');

      const result = await harness.run('analyze sqaa');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('change set is clean');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'default mode: includes untracked non-ignored files',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      // New untracked file — not in any commit, not ignored
      harness.cwd.writeFile('new-feature.ts', 'export const x = 1;');

      const result = await harness.run('analyze sqaa');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('change set is clean');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'default mode: excludes git-ignored files',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      // Append dist/ to the existing .gitignore (already committed in beforeEach)
      commitFile(harness.cwd.path, '.gitignore', '.claude/\ndist/\n');
      harness.cwd.writeFile('dist/bundle.js', 'console.log("built");');

      const result = await harness.run('analyze sqaa');

      expect(result.exitCode).toBe(0);
      // No files to analyze (ignored file excluded, nothing else changed)
      expect(result.stdout + result.stderr).toContain('no files in the change set');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --staged and --base are combined',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      commitFile(harness.cwd.path, 'README.md', 'hello');

      const result = await harness.run('analyze sqaa --staged --base main');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain(
        '--staged and --base cannot be used together',
      );
    },
    { timeout: 15000 },
  );

  it(
    'warns but auto-proceeds in non-TTY when change set exceeds the large-set threshold',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      for (let i = 1; i <= 21; i++) {
        harness.cwd.writeFile(`file${i}.ts`, `const x${i} = ${i};`);
      }

      const result = await harness.run('analyze sqaa');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('large number of files (21)');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(21);
    },
    { timeout: 30000 },
  );

  it(
    'skips the large change set warning with --force',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      for (let i = 1; i <= 21; i++) {
        harness.cwd.writeFile(`file${i}.ts`, `const x${i} = ${i};`);
      }

      const result = await harness.run('analyze sqaa --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('large number of files');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(21);
    },
    { timeout: 30000 },
  );

  it(
    '--staged: analyzes only staged files',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      stageFile(harness.cwd.path, 'staged.ts', 'const s = 1;');
      // Unstaged modification — should not be included
      harness.cwd.writeFile('unstaged.ts', 'const u = 1;');

      const result = await harness.run('analyze sqaa --staged');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('change set is clean');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    '--staged: exits with code 0 and no API call when nothing is staged',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');

      const result = await harness.run('analyze sqaa --staged');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('no files in the change set');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    '--base <branch>: analyzes files changed vs base branch',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      // Establish a base commit on master
      commitFile(harness.cwd.path, 'base.ts', 'const base = 1;');
      // Create a feature branch and add a new file
      git(['checkout', '-b', 'feature'], harness.cwd.path);
      commitFile(harness.cwd.path, 'feature.ts', 'const f = 1;');

      const result = await harness.run('analyze sqaa --base master');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('change set is clean');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 51 when issues are found in change-set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({
          issues: [{ rule: 'ts:S1234', message: 'Fix this', startLine: 1 }],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('dirty.ts', 'const x = 1;');

      const result = await harness.run('analyze sqaa');

      expect(result.exitCode).toBe(51);
      expect(result.stdout + result.stderr).toContain('Fix this');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and skips SQAA for on-premise server in change-set mode',
    async () => {
      const server = await harness.newFakeServer().withAuthToken(VALID_TOKEN).start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN); // no orgKey → on-premise

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('app.ts', 'const a = 1;');

      const result = await harness.run('analyze sqaa');

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 0 and warns when no project is configured in change-set mode',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      // Cloud auth but no extension registered → no projectKey in registry → skip
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('app.ts', 'const a = 1;');

      const result = await harness.run('analyze sqaa');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        'SonarQube Agentic Analysis skipped: no project configured',
      );
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'excludes binary files from the change set',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      // Write a file with a NUL byte — detected as binary and excluded
      writeFileSync(join(harness.cwd.path, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x4e]));

      const result = await harness.run('analyze sqaa');

      expect(result.exitCode).toBe(0);
      // Binary file shown as IGNORED — no files to analyze
      expect(result.stdout + result.stderr).toContain('all change set files were excluded');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'excludes files that exceed the 10 MB size limit',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      // Write a file slightly over 10 MB
      writeFileSync(join(harness.cwd.path, 'huge.ts'), Buffer.alloc(10 * 1024 * 1024 + 1, 'a'));

      const result = await harness.run('analyze sqaa');

      expect(result.exitCode).toBe(0);
      // Oversized file shown as IGNORED — no files to analyze
      expect(result.stdout + result.stderr).toContain('all change set files were excluded');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
    },
    { timeout: 15000 },
  );

  it(
    'does not report "change set is clean" when the API returned errors for every file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({
          issues: [],
          errors: [{ code: 'NOT_ENTITLED', message: 'Organization is not entitled to SQAA' }],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      stageFile(harness.cwd.path, 'staged.ts', 'const s = 1;');

      const result = await harness.run('analyze sqaa --staged');

      const output = result.stdout + result.stderr;
      expect(output).toContain('NOT_ENTITLED');
      // No issues were reported, so exit code must not be 51.
      expect(result.exitCode).not.toBe(51);
      // When the server returned errors for every file, don't mislead the user with "clean".
      expect(output).not.toContain('change set is clean');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when the cwd is not a git repository',
    async () => {
      // Create a second harness whose cwd is not a git repo (no initGitRepo called).
      const bareHarness = await TestHarness.create();
      const server = await bareHarness.newFakeServer().withAuthToken(VALID_TOKEN).start();

      bareHarness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(bareHarness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      bareHarness.cwd.writeFile('app.ts', 'const a = 1;');

      const result = await bareHarness.run('analyze sqaa');

      await bareHarness.dispose();

      // git diff HEAD fails with non-zero exit outside a git repo → CommandFailedError → exit 1
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('git diff failed');
    },
    { timeout: 15000 },
  );
});

describe('verify — change-set mode (no --file)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, '.gitignore', '.claude/\n');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'default mode: analyzes untracked files and reports no issues',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('new.ts', 'const x = 1;');

      const result = await harness.run('verify');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('change set is clean');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    '--staged: analyzes only staged files',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      stageFile(harness.cwd.path, 'staged.ts', 'const s = 1;');
      harness.cwd.writeFile('unstaged.ts', 'const u = 1;');

      const result = await harness.run('verify --staged');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('change set is clean');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      // Only staged.ts is sent — unstaged.ts is excluded
      expect(sqaaCalls).toHaveLength(1);
    },
    { timeout: 15000 },
  );

  it(
    'warns but auto-proceeds in non-TTY when change set exceeds the large-set threshold',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      for (let i = 1; i <= 21; i++) {
        harness.cwd.writeFile(`file${i}.ts`, `const x${i} = ${i};`);
      }

      const result = await harness.run('verify');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).toContain('large number of files (21)');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(21);
    },
    { timeout: 30000 },
  );

  it(
    'skips the large change set warning with --force',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      for (let i = 1; i <= 21; i++) {
        harness.cwd.writeFile(`file${i}.ts`, `const x${i} = ${i};`);
      }

      const result = await harness.run('verify --force');

      expect(result.exitCode).toBe(0);
      expect(result.stdout + result.stderr).not.toContain('large number of files');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(21);
    },
    { timeout: 30000 },
  );
});

describe('analyze sqaa — API error codes', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 and shows rate-limit message on 429',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(429)
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Rate limit reached');
    },
    { timeout: 15000 },
  );

  it(
    'retries 3 times on 503 then exits with code 1',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(503)
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Server busy');
      // 4 total attempts: 1 initial + 3 retries
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(4);
    },
    { timeout: 30000 },
  );

  it(
    'retries 503 for multiple files concurrently in change-set mode',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaStatusCode(503)
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, '.gitignore', '.claude/\n');
      // Two files in the same batch will both hit 503 concurrently.
      harness.cwd.writeFile('a.ts', 'const a = 1;');
      harness.cwd.writeFile('b.ts', 'const b = 2;');

      const result = await harness.run('analyze sqaa');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Server busy');
      // Each file gets 1 initial + 3 retries = 4 attempts; 2 files = 8 total.
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(8);
    },
    { timeout: 60000 },
  );

  it(
    'outputs errors to stderr and results to stdout',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [{ rule: 'ts:S1135', message: 'TODO', startLine: 1 }] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', '// TODO: fix\nconst x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts');

      expect(result.exitCode).toBe(51);
      // Issue details are on stdout.
      expect(result.stdout).toContain('TODO');
      // No Sonar error text should appear on stdout.
      expect(result.stdout).not.toContain('❌ SonarQube Agentic Analysis failed');
    },
    { timeout: 15000 },
  );
});

describe('analyze sqaa — --format json', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, '.gitignore', '.claude/\n');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'outputs valid JSON report for a clean single file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', 'const x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts --format json');

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        files: { path: string; issues: unknown[] }[];
        ignored: unknown[];
        failures: unknown[];
        summary: { totalIssues: number; totalFailures: number };
      };
      expect(report.files).toHaveLength(1);
      expect(report.files[0].path).toBe('src/index.ts');
      expect(report.files[0].issues).toHaveLength(0);
      expect(report.ignored).toHaveLength(0);
      expect(report.failures).toHaveLength(0);
      expect(report.summary.totalIssues).toBe(0);
      expect(report.summary.totalFailures).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'outputs valid JSON report with issues for single file',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({
          issues: [{ rule: 'ts:S1135', message: 'Fix this TODO', startLine: 1 }],
        })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      harness.cwd.writeFile('src/index.ts', '// TODO: fix\nconst x = 1;');

      const result = await harness.run('analyze sqaa --file src/index.ts --format json');

      expect(result.exitCode).toBe(51);
      const report = JSON.parse(result.stdout) as {
        files: { path: string; issues: { rule: string; message: string }[] }[];
        summary: { totalIssues: number };
      };
      expect(report.files[0].issues).toHaveLength(1);
      expect(report.files[0].issues[0].rule).toBe('ts:S1135');
      expect(report.summary.totalIssues).toBe(1);
    },
    { timeout: 15000 },
  );

  it(
    'outputs valid JSON report for change-set mode with ignored files',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();

      harness
        .state()
        .withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG)
        .withSqaaExtension(harness.cwd.path, TEST_PROJECT, TEST_ORG, server.baseUrl());

      commitFile(harness.cwd.path, 'README.md', 'hello');
      harness.cwd.writeFile('src/index.ts', 'const x = 1;');
      // Binary file — should appear in ignored
      writeFileSync(join(harness.cwd.path, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x4e]));

      const result = await harness.run('analyze sqaa --format json');

      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        files: { path: string }[];
        ignored: { path: string; reason: string }[];
        failures: unknown[];
        summary: { totalIssues: number; totalFailures: number };
      };
      expect(report.files).toHaveLength(1);
      expect(report.files[0].path).toBe('src/index.ts');
      expect(report.ignored).toHaveLength(1);
      expect(report.ignored[0].reason).toBe('binary');
      expect(report.failures).toHaveLength(0);
      expect(report.summary.totalIssues).toBe(0);
    },
    { timeout: 15000 },
  );
});
