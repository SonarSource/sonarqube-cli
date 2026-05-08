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

// Integration tests for `sonar hook claude-post-tool-use`.

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const TEST_PROJECT = 'my-project';

function postToolUseStdin(filePath: string, toolName = 'Edit'): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath } });
}

describe('sonar hook claude-post-tool-use', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 and outputs Agentic Analysis JSON when analysis returns no issues',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');
      const filePath = join(harness.cwd.path, 'src/main.ts');

      const result = await harness.run(`hook claude-post-tool-use --project ${TEST_PROJECT}`, {
        stdin: postToolUseStdin(filePath),
      });

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
      expect(output.hookSpecificOutput.additionalContext).toContain('no issues');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs no hook response when not authenticated',
    async () => {
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');
      const filePath = join(harness.cwd.path, 'src/main.ts');

      const result = await harness.run(`hook claude-post-tool-use --project ${TEST_PROJECT}`, {
        stdin: postToolUseStdin(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    },
    { timeout: 15000 },
  );

  it(
    'silently skips SQAA when the file is outside the current working directory',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      // Write a real file one level above cwd so `existsSync` succeeds and
      // the handler reaches the path validation step. The file lives in the
      // harness tempDir (sibling of cwd) and is cleaned up by dispose().
      harness.cwd.writeFile('../outside.ts', 'const x = 1;');
      const outsidePath = join(harness.cwd.path, '..', 'outside.ts');

      const result = await harness.run(`hook claude-post-tool-use --project ${TEST_PROJECT}`, {
        stdin: postToolUseStdin(outsidePath),
        extraEnv: { LOG_LEVEL: 'DEBUG' },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(0);
      const logFile = harness.cliHome.dir('logs').file('sonarqube-cli.log');
      expect(logFile.exists()).toBe(true);
      expect(logFile.asText()).toContain(
        `PostToolUse SQAA skipped: file outside cwd: ${outsidePath}`,
      );
    },
    { timeout: 15000 },
  );

  it.skipIf(process.platform !== 'win32')(
    'POSIX-normalizes Windows-style separators before sending to SQAA',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withSqaaResponse({ issues: [] })
        .start();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);
      harness.cwd.writeFile('src/main.ts', 'const x = 1;');
      // On Windows, path.join produces backslash-separated paths.
      // The helper must rewrite them to POSIX before sending to SQAA.
      const filePath = join(harness.cwd.path, 'src', 'main.ts');

      const result = await harness.run(`hook claude-post-tool-use --project ${TEST_PROJECT}`, {
        stdin: postToolUseStdin(filePath),
      });

      expect(result.exitCode).toBe(0);
      const sqaaCalls = server
        .getRecordedRequests()
        .filter((r) => r.path === '/a3s-analysis/analyses');
      expect(sqaaCalls).toHaveLength(1);
      const body = JSON.parse(sqaaCalls[0].body ?? '{}') as { filePath?: string };
      expect(body.filePath).toBe('src/main.ts');
    },
    { timeout: 15000 },
  );
});
