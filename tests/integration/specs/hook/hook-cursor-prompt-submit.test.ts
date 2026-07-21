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

// Integration tests for `sonar hook cursor-prompt-submit`.
// Runs the actual binary with real stdin to exercise scanText (stdinData path) in process.ts.
// Cursor blocks with `{ "continue": false, "user_message": "..." }`, unlike Claude/Codex.
//
// Note: hardcoded token below is an intentional test fixture for the secret scanner.
// sonar-ignore-next-line S6769

import { chmodSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLocalBinaryName } from '../../../../src/commands/_common/install/secrets.js';
import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '../../../../src/commands/hook/hook-dependencies.js';
import { detectPlatform } from '../../../../src/lib/platform-detector.js';
import { TestHarness } from '../../harness';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';

// Unreachable server — binary handles connection-refused gracefully and proceeds with scan
const FAKE_SERVER = 'http://localhost:19999';

function findContinueLine(stdout: string): string | undefined {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{') && l.includes('"continue"'));
}

describe('sonar hook cursor-prompt-submit', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 and outputs Cursor block JSON when prompt contains a secret',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('hook cursor-prompt-submit', {
        stdin: JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      });

      expect(result.exitCode).toBe(0);
      const blockLine = findContinueLine(result.stdout);
      expect(blockLine).toBeDefined();
      const output = JSON.parse(blockLine ?? '{}');
      expect(output.continue).toBe(false);
      expect(output.user_message).toContain('secrets');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and outputs nothing when prompt contains no secrets',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('hook cursor-prompt-submit', {
        stdin: JSON.stringify({ prompt: 'please help me refactor this function' }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"continue"');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and outputs nothing when stdin is invalid JSON',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('hook cursor-prompt-submit', {
        stdin: 'not valid json {{',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"continue"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs nothing when prompt field is absent',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('hook cursor-prompt-submit', {
        stdin: JSON.stringify({ hook_event_name: 'beforeSubmitPrompt' }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"continue"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and blocks with the unauthenticated message when not authenticated',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      // no withAuth — no active connection

      const result = await harness.run('hook cursor-prompt-submit', {
        stdin: JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      });

      expect(result.exitCode).toBe(0);
      const blockLine = findContinueLine(result.stdout);
      expect(blockLine).toBeDefined();
      const output = JSON.parse(blockLine ?? '{}');
      expect(output.continue).toBe(false);
      expect(output.user_message).toBe(SECRETS_INACTIVE_UNAUTHENTICATED);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and blocks with the binary-missing message when secrets binary is not installed',
    async () => {
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.run('hook cursor-prompt-submit', {
        stdin: JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      });

      expect(result.exitCode).toBe(0);
      const blockLine = findContinueLine(result.stdout);
      expect(blockLine).toBeDefined();
      const output = JSON.parse(blockLine ?? '{}');
      expect(output.continue).toBe(false);
      expect(output.user_message).toBe(SECRETS_INACTIVE_BINARY_MISSING);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and outputs nothing when binary spawn fails',
    async () => {
      harness.withAuth(FAKE_SERVER, 'fake-token');

      // Place a non-executable file at the binary path so spawnProcess throws EACCES.
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, 0o644);

      const result = await harness.run('hook cursor-prompt-submit', {
        stdin: JSON.stringify({ prompt: 'please help me refactor' }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"continue"');
    },
    { timeout: 10000 },
  );
});
