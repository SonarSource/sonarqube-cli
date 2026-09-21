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

import { chmodSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '@/commands/hook/hook-dependencies.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalBinaryName } from '@/core/host/install/secrets.ts';

import { readStatsEvents } from '../../../_common/stats-helpers.ts';
import { TestHarness } from '../../harness';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
// Second fixture, same length/prefix position as GITHUB_TEST_TOKEN above (only the value differs)
// sonar-ignore-next-line S6769
const OTHER_TEST_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234';

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

      const result = await harness.runWithStdin(
        'hook claude-prompt-submit',
        JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      );

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
    'records a separate stats finding for a different prompt with a secret at the same position',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      // Same rule, same line/column (identical "my token is " prefix) — different prompts.
      // sonar-secrets reports no `file` for --input scans, so without hashing the prompt text
      // as a dedup source, the second scan would wrongly collide with the first and report 0.
      const first = await harness.runWithStdin(
        'hook claude-prompt-submit',
        JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      );
      expect(first.exitCode).toBe(0);

      const second = await harness.runWithStdin(
        'hook claude-prompt-submit',
        JSON.stringify({ prompt: `my token is ${OTHER_TEST_TOKEN}` }),
      );
      expect(second.exitCode).toBe(0);

      const events = readStatsEvents(harness.sonarUserHome.path);
      expect(events).toHaveLength(2);
      expect(events[0].parsedDetails.findingsCount).toBe(1);
      expect(events[1].parsedDetails.findingsCount).toBe(1);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and outputs nothing when prompt contains no secrets',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.runWithStdin(
        'hook claude-prompt-submit',
        JSON.stringify({ prompt: 'please help me refactor this function' }),
      );

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

      const result = await harness.runWithStdin('hook claude-prompt-submit', 'not valid json {{');

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

      const result = await harness.runWithStdin(
        'hook claude-prompt-submit',
        JSON.stringify({ tool_name: 'Read' }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"block"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and blocks with the unauthenticated message when not authenticated',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      // no withAuth — no active connection

      const result = await harness.runWithStdin(
        'hook claude-prompt-submit',
        JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      );

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout.trim()) as { decision: string; reason: string };
      expect(payload.decision).toBe('block');
      expect(payload.reason).toBe(SECRETS_INACTIVE_UNAUTHENTICATED);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and blocks with the binary-missing message when secrets binary is not installed',
    async () => {
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.runWithStdin(
        'hook claude-prompt-submit',
        JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      );

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(result.stdout.trim()) as { decision: string; reason: string };
      expect(payload.decision).toBe('block');
      expect(payload.reason).toBe(SECRETS_INACTIVE_BINARY_MISSING);
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

      const result = await harness.runWithStdin(
        'hook claude-prompt-submit',
        JSON.stringify({ prompt: 'please help me refactor' }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"block"');
    },
    { timeout: 10000 },
  );
});
