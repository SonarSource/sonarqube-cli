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

// Integration tests for `sonar hook claude-pre-tool-use`.
// These tests run the actual binary with real stdin to exercise secrets-scan.ts and stdin.ts.
//
// Note: hardcoded token below is an intentional test fixture for the secret scanner.
// sonar-ignore-next-line S6769

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { TestHarness } from '../../harness';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';

// Unreachable server — binary handles connection-refused gracefully and proceeds with scan
const FAKE_SERVER = 'http://localhost:19999';

function preToolUseStdin(filePath: string): string {
  return JSON.stringify({ tool_name: 'Read', tool_input: { file_path: filePath } });
}

/**
 * Extract the hook JSON response line from stdout.
 * Other output (e.g. post-update messages) may also be present.
 */
function findHookJsonLine(stdout: string): string | undefined {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{') && l.includes('hookSpecificOutput'));
}

describe('sonar hook claude-pre-tool-use', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 and outputs deny JSON when file contains a secret',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: preToolUseStdin(filePath),
      });

      expect(result.exitCode).toBe(0);
      const hookOutput = findHookJsonLine(result.stdout) ?? '';
      expect(hookOutput).not.toBe('');
      const output = JSON.parse(hookOutput);
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain(filePath);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and outputs no hook response when file contains no secrets',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');
      harness.cwd.writeFile('clean.js', CLEAN_CONTENT);
      const filePath = join(harness.cwd.path, 'clean.js');

      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: preToolUseStdin(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(findHookJsonLine(result.stdout)).toBeUndefined();
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and outputs no hook response when secrets binary is not installed',
    async () => {
      harness.withAuth(FAKE_SERVER, 'fake-token');
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: preToolUseStdin(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(findHookJsonLine(result.stdout)).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs no hook response when tool is not Read',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }),
      });

      expect(result.exitCode).toBe(0);
      expect(findHookJsonLine(result.stdout)).toBeUndefined();
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs no hook response when stdin is invalid JSON',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: 'not valid json {{',
      });

      expect(result.exitCode).toBe(0);
      expect(findHookJsonLine(result.stdout)).toBeUndefined();
    },
    { timeout: 15000 },
  );
});
