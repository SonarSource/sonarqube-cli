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

// Integration tests for `sonar hook claude-pre-tool-use`:
// JSON stdin parsing, graceful skips, and end-to-end secret detection in files
// that Claude Code is about to read.
//
// Behaviour contract:
//   - Always exits 0 (hook must never crash Claude Code)
//   - Outputs {"hookSpecificOutput":{"permissionDecision":"deny",...}} when a secret is found
//   - Outputs nothing when the file is clean, tool is not Read, or file doesn't exist

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';

// Unreachable but well-formed server URL: binary handles connection-refused gracefully.
const FAKE_SERVER = 'http://localhost:19999';
const VALID_TOKEN = 'integration-test-token';

function readPayload(filePath: string): string {
  return JSON.stringify({ tool_name: 'Read', tool_input: { file_path: filePath } });
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
    'exits 0 and allows when stdin is malformed JSON',
    async () => {
      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: 'not valid json',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows for non-Read tools',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: filePath } }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when file does not exist',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: readPayload('/nonexistent/path/file.js'),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when not authenticated (graceful skip)',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');
      // No auth configured

      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: readPayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when binary is not installed (graceful skip)',
    async () => {
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');
      // No binary installed

      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: readPayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows a clean file',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('clean.js', CLEAN_CONTENT);
      const filePath = join(harness.cwd.path, 'clean.js');

      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: readPayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and outputs deny decision when file contains a secret',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.run('hook claude-pre-tool-use', {
        stdin: readPayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"permissionDecision"');
      expect(result.stdout).toContain('"deny"');
    },
    { timeout: 30000 },
  );
});
