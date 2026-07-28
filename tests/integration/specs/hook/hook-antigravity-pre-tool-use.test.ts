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

// Integration tests for `sonar hook antigravity-pre-tool-use`:
// JSON stdin parsing, graceful skips, and end-to-end secret detection in files
// that Antigravity is about to read via `view_file`.
//
// Behaviour contract:
//   - Always exits 0 (hook must never crash Antigravity)
//   - Stdin payload is { toolCall: { name: "view_file", args: { AbsolutePath: "<path>" } } }
//   - Outputs {"decision":"deny","reason":"..."} on a hit (flat schema, no wrapper)
//   - Outputs nothing when the file is clean, tool is not `view_file`, or args/file are missing

import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '@/commands/hook/hook-dependencies.ts';
import { buildLocalBinaryName } from '@/core/host/install/secrets.ts';
import { detectPlatform } from '@/core/host/platform-detector.ts';

import { TestHarness } from '../../harness';

// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';

// Unreachable but well-formed server URL: binary handles connection-refused gracefully.
const FAKE_SERVER = 'http://localhost:19999';
const VALID_TOKEN = 'integration-test-token';

function viewFilePayload(filePath: string): string {
  return JSON.stringify({
    toolCall: {
      name: 'view_file',
      args: { AbsolutePath: filePath },
    },
  });
}

describe('sonar hook antigravity-pre-tool-use', () => {
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
      const result = await harness.run('hook antigravity-pre-tool-use', {
        stdin: 'not valid json',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when toolCall.name is not "view_file"',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.run('hook antigravity-pre-tool-use', {
        stdin: JSON.stringify({
          toolCall: {
            name: 'run_command',
            args: { CommandLine: `cat ${filePath}` },
          },
        }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when AbsolutePath is missing',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.run('hook antigravity-pre-tool-use', {
        stdin: JSON.stringify({
          toolCall: { name: 'view_file', args: {} },
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

      const result = await harness.run('hook antigravity-pre-tool-use', {
        stdin: viewFilePayload('/nonexistent/path/file.js'),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and denies with the unauthenticated message when not authenticated',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.run('hook antigravity-pre-tool-use', {
        stdin: viewFilePayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.decision).toBe('deny');
      expect(output.reason).toBe(SECRETS_INACTIVE_UNAUTHENTICATED);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and denies with the binary-missing message when binary is not installed',
    async () => {
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.run('hook antigravity-pre-tool-use', {
        stdin: viewFilePayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.decision).toBe('deny');
      expect(output.reason).toBe(SECRETS_INACTIVE_BINARY_MISSING);
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

      const result = await harness.run('hook antigravity-pre-tool-use', {
        stdin: viewFilePayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and emits decision: deny when the file contains a secret',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const result = await harness.run('hook antigravity-pre-tool-use', {
        stdin: viewFilePayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"decision"');
      expect(result.stdout).toContain('"deny"');
      expect(result.stdout).toContain('"reason"');
      expect(result.stdout).toContain('Sonar detected secrets in file');
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and emits no deny when the binary spawn fails mid-scan',
    async () => {
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const filePath = join(harness.cwd.path, 'secret.js');

      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, 0o644);

      const result = await harness.run('hook antigravity-pre-tool-use', {
        stdin: viewFilePayload(filePath),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"deny"');
      expect(result.stdout).not.toContain('"decision"');
    },
    { timeout: 15000 },
  );
});
