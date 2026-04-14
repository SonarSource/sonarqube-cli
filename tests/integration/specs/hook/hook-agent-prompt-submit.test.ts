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

// Integration tests for `sonar hook claude-prompt-submit`.
// Runs the actual binary with real stdin to exercise scanText (stdinData path) in process.ts.
//
// Note: hardcoded token below is an intentional test fixture for the secret scanner.
// sonar-ignore-next-line S6769

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync } from 'node:fs';
import { TestHarness } from '../../harness';
import { detectPlatform } from '../../../../src/lib/platform-detector.js';
import { buildLocalBinaryName } from '../../../../src/cli/commands/_common/install/secrets.js';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';

// Unreachable server — binary handles connection-refused gracefully and proceeds with scan
const FAKE_SERVER = 'http://localhost:19999';

describe('sonar hook claude-prompt-submit', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 and outputs block JSON when prompt contains a secret',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('hook claude-prompt-submit', {
        stdin: JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      });

      expect(result.exitCode).toBe(0);
      const blockLine = result.stdout
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('{') && l.includes('"block"'));
      expect(blockLine).toBeDefined();
      const output = JSON.parse(blockLine ?? '{}');
      expect(output.decision).toBe('block');
      expect(output.reason).toContain('secrets');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and outputs nothing when prompt contains no secrets',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('hook claude-prompt-submit', {
        stdin: JSON.stringify({ prompt: 'please help me refactor this function' }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"block"');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and outputs nothing when stdin is invalid JSON',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('hook claude-prompt-submit', {
        stdin: 'not valid json {{',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"block"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs nothing when prompt field is absent',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('hook claude-prompt-submit', {
        stdin: JSON.stringify({ tool_name: 'Read' }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"block"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs nothing when not authenticated',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      // no withAuth — no active connection

      const result = await harness.run('hook claude-prompt-submit', {
        stdin: JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"block"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs nothing when secrets binary is not installed',
    async () => {
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('hook claude-prompt-submit', {
        stdin: JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"block"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs nothing when binary spawn fails',
    async () => {
      harness.withAuth(FAKE_SERVER, 'fake-token');

      // Place a non-executable file at the binary path so spawnProcess throws EACCES.
      // This exercises the catch block in agentPromptSubmit and the body of runSecretsBinaryOnText.
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, 0o644);

      const result = await harness.run('hook claude-prompt-submit', {
        stdin: JSON.stringify({ prompt: 'please help me refactor' }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"block"');
    },
    { timeout: 10000 },
  );
});
