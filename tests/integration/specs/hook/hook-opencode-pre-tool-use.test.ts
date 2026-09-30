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

import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '@/commands/hook/hook-dependencies.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalBinaryName } from '@/core/host/install/secrets.ts';

import { TestHarness } from '../../harness';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';

const FAKE_SERVER = 'http://localhost:19999';
const FAKE_TOKEN = 'fake-token';

interface Decision {
  block: boolean;
  reason?: string;
}

function readPayload(filePath: string, tool = 'read'): string {
  return JSON.stringify({ tool, filePath, sessionID: 'ses_test' });
}

function parseDecision(stdout: string): Decision {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{') && l.includes('"block"'));
  expect(line).toBeDefined();
  return JSON.parse(line ?? '{}') as Decision;
}

describe('sonar hook opencode-pre-tool-use', () => {
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
      const result = await harness.runWithStdin('hook opencode-pre-tool-use', 'not valid json');

      expect(result.exitCode).toBe(0);
      expect(parseDecision(result.stdout)).toEqual({ block: false });
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows for non-read tools',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.runWithStdin(
        'hook opencode-pre-tool-use',
        readPayload(filePath, 'write'),
      );

      expect(result.exitCode).toBe(0);
      expect(parseDecision(result.stdout)).toEqual({ block: false });
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when the file path is absent',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);

      const result = await harness.runWithStdin(
        'hook opencode-pre-tool-use',
        JSON.stringify({ tool: 'read' }),
      );

      expect(result.exitCode).toBe(0);
      expect(parseDecision(result.stdout)).toEqual({ block: false });
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when the file does not exist',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);

      const result = await harness.runWithStdin(
        'hook opencode-pre-tool-use',
        readPayload('/nonexistent/path/file.js'),
      );

      expect(result.exitCode).toBe(0);
      expect(parseDecision(result.stdout)).toEqual({ block: false });
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and blocks with the unauthenticated message when not authenticated',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.runWithStdin(
        'hook opencode-pre-tool-use',
        readPayload(filePath),
      );

      expect(result.exitCode).toBe(0);
      expect(parseDecision(result.stdout)).toEqual({
        block: true,
        reason: SECRETS_INACTIVE_UNAUTHENTICATED,
      });
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and blocks with the binary-missing message when the secrets binary is not installed',
    async () => {
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.runWithStdin(
        'hook opencode-pre-tool-use',
        readPayload(filePath),
      );

      expect(result.exitCode).toBe(0);
      expect(parseDecision(result.stdout)).toEqual({
        block: true,
        reason: SECRETS_INACTIVE_BINARY_MISSING,
      });
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows a clean file',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);
      harness.cwd.writeFile('clean.js', CLEAN_CONTENT);
      const filePath = join(harness.cwd.path, 'clean.js');

      const result = await harness.runWithStdin(
        'hook opencode-pre-tool-use',
        readPayload(filePath),
      );

      expect(result.exitCode).toBe(0);
      expect(parseDecision(result.stdout)).toEqual({ block: false });
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and blocks when the file contains a secret',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.runWithStdin(
        'hook opencode-pre-tool-use',
        readPayload(filePath),
      );

      expect(result.exitCode).toBe(0);
      const decision = parseDecision(result.stdout);
      expect(decision.block).toBe(true);
      expect(decision.reason).toContain(filePath);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and fails closed when the secrets binary cannot be spawned',
    async () => {
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);
      harness.cwd.writeFile('clean.js', CLEAN_CONTENT);
      const filePath = join(harness.cwd.path, 'clean.js');
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, 0o644);

      const result = await harness.runWithStdin(
        'hook opencode-pre-tool-use',
        readPayload(filePath),
      );

      expect(result.exitCode).toBe(0);
      const decision = parseDecision(result.stdout);
      expect(decision.block).toBe(true);
      expect(decision.reason).toContain('failed unexpectedly');
    },
    { timeout: 10000 },
  );
});
