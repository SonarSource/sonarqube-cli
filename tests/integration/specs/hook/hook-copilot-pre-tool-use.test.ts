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

// Integration tests for `sonar hook copilot-pre-tool-use`:
// JSON stdin parsing, graceful skips, and end-to-end secret detection in files
// that GitHub Copilot CLI is about to read.
//
// Behaviour contract (differs from the Claude hook):
//   - Always exits 0 (hook must never crash Copilot CLI)
//   - Stdin payload is { toolName: "view", toolArgs: "<JSON-encoded string>" }
//     (camelCase; toolArgs is a stringified JSON, not a nested object)
//   - Outputs {"permissionDecision":"deny","permissionDecisionReason":"..."} on a hit
//     (no `hookSpecificOutput` wrapper)
//   - Outputs nothing when the file is clean, tool is not `view`, or args/file are missing

import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLocalBinaryName } from '../../../../src/cli/commands/_common/install/secrets.js';
import { detectPlatform } from '../../../../src/lib/platform-detector.js';
import { TestHarness } from '../../harness';

// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';

// Unreachable but well-formed server URL: binary handles connection-refused gracefully.
const FAKE_SERVER = 'http://localhost:19999';
const VALID_TOKEN = 'integration-test-token';

function viewPayload(filePath: string): string {
  return JSON.stringify({ toolName: 'view', toolArgs: JSON.stringify({ path: filePath }) });
}

describe('sonar hook copilot-pre-tool-use', () => {
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
      const result = await harness.run('hook copilot-pre-tool-use', {
        stdin: 'not valid json',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when toolName is not "view"',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.run('hook copilot-pre-tool-use', {
        stdin: JSON.stringify({
          toolName: 'edit',
          toolArgs: JSON.stringify({ path: filePath }),
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when toolArgs is not parseable as JSON',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.run('hook copilot-pre-tool-use', {
        stdin: JSON.stringify({ toolName: 'view', toolArgs: 'not-json-string' }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when toolArgs.path is missing',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.run('hook copilot-pre-tool-use', {
        stdin: JSON.stringify({
          toolName: 'view',
          toolArgs: JSON.stringify({ other: 'something' }),
        }),
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

      const result = await harness.run('hook copilot-pre-tool-use', {
        stdin: viewPayload('/nonexistent/path/file.js'),
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

      const result = await harness.run('hook copilot-pre-tool-use', {
        stdin: viewPayload(filePath),
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

      const result = await harness.run('hook copilot-pre-tool-use', {
        stdin: viewPayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows a clean file (no output)',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('clean.js', CLEAN_CONTENT);
      const filePath = join(harness.cwd.path, 'clean.js');

      const result = await harness.run('hook copilot-pre-tool-use', {
        stdin: viewPayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and emits permissionDecision: deny when the file contains a secret',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.run('hook copilot-pre-tool-use', {
        stdin: viewPayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"permissionDecision"');
      expect(result.stdout).toContain('"deny"');
      expect(result.stdout).toContain('"permissionDecisionReason"');
      expect(result.stdout).toContain('Sonar detected secrets in file');
      // No `hookSpecificOutput` wrapper (Copilot uses a flat schema).
      expect(result.stdout).not.toContain('hookSpecificOutput');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and emits no deny when the binary spawn fails mid-scan',
    async () => {
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      // Place a non-executable file at the binary path so spawnProcess throws EACCES.
      // This exercises the catch block in copilotPreToolUse: the hook contract requires
      // exit 0 and no deny output when the binary itself errors (killed mid-scan, OOM, etc.).
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, 0o644);

      const result = await harness.run('hook copilot-pre-tool-use', {
        stdin: viewPayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
      expect(result.stdout).not.toContain('"permissionDecision"');
    },
    { timeout: 15000 },
  );
});
