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

import { generateKeyPairSync } from 'node:crypto';
import { chmodSync } from 'node:fs';

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

const FAKE_SERVER = 'http://localhost:19999';
const FAKE_TOKEN = 'fake-token';

interface Decision {
  block: boolean;
  reason?: string;
  redactedText?: string;
  secretsFound?: number;
}

function messagePayload(text: string): string {
  return JSON.stringify({ text, sessionID: 'ses_test' });
}

function parseDecision(stdout: string): Decision {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{') && l.includes('"block"'));
  expect(line).toBeDefined();
  return JSON.parse(line ?? '{}') as Decision;
}

describe('sonar hook opencode-chat-message', () => {
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
      const result = await harness.runWithStdin('hook opencode-chat-message', 'not valid json');

      expect(result.exitCode).toBe(0);
      expect(parseDecision(result.stdout)).toEqual({ block: false });
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 and allows when the text field is absent',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);

      const result = await harness.runWithStdin(
        'hook opencode-chat-message',
        JSON.stringify({ sessionID: 'ses_test' }),
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

      const result = await harness.runWithStdin(
        'hook opencode-chat-message',
        messagePayload(`my token is ${GITHUB_TEST_TOKEN}`),
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

      const result = await harness.runWithStdin(
        'hook opencode-chat-message',
        messagePayload(`my token is ${GITHUB_TEST_TOKEN}`),
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
    'exits 0 and allows a message without secrets',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);

      const result = await harness.runWithStdin(
        'hook opencode-chat-message',
        messagePayload('please help me refactor this function'),
      );

      expect(result.exitCode).toBe(0);
      expect(parseDecision(result.stdout)).toEqual({ block: false });
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and masks the secret in place without blocking the message',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);
      const before = 'please push a commit using my token ';
      const after = ' to the remote';

      const result = await harness.runWithStdin(
        'hook opencode-chat-message',
        messagePayload(`${before}${GITHUB_TEST_TOKEN}${after}`),
      );

      expect(result.exitCode).toBe(0);
      const decision = parseDecision(result.stdout);
      expect(decision.block).toBe(false);
      expect(decision.secretsFound).toBe(1);
      expect(decision.redactedText).toBeDefined();
      expect(decision.redactedText).not.toContain(GITHUB_TEST_TOKEN);
      expect(decision.redactedText?.startsWith(before)).toBe(true);
      expect(decision.redactedText?.endsWith(after)).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and masks the location reported for a multi-line private key',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
        publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      });
      const header = '-----BEGIN RSA PRIVATE KEY-----';

      const result = await harness.runWithStdin(
        'hook opencode-chat-message',
        messagePayload(`use this key:\n${privateKey}\nto sign the release`),
      );

      expect(result.exitCode).toBe(0);
      const decision = parseDecision(result.stdout);
      expect(decision.block).toBe(false);
      expect(decision.redactedText).toBeDefined();
      expect(decision.redactedText).not.toContain(header);
      expect(decision.redactedText?.startsWith('use this key:\n')).toBe(true);
      expect(decision.redactedText?.endsWith('\nto sign the release')).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and masks a secret that is not on the first line',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);
      const firstLine = 'here is my configuration:';
      const lastLine = 'can you use it to push?';

      const result = await harness.runWithStdin(
        'hook opencode-chat-message',
        messagePayload(`${firstLine}\ntoken=${GITHUB_TEST_TOKEN}\n${lastLine}`),
      );

      expect(result.exitCode).toBe(0);
      const decision = parseDecision(result.stdout);
      expect(decision.block).toBe(false);
      expect(decision.redactedText).not.toContain(GITHUB_TEST_TOKEN);
      expect(decision.redactedText?.startsWith(`${firstLine}\ntoken=`)).toBe(true);
      expect(decision.redactedText?.endsWith(`\n${lastLine}`)).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and fails closed when the secrets binary cannot be spawned',
    async () => {
      harness.withAuth(FAKE_SERVER, FAKE_TOKEN);
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, 0o644);

      const result = await harness.runWithStdin(
        'hook opencode-chat-message',
        messagePayload('please help me refactor'),
      );

      expect(result.exitCode).toBe(0);
      const decision = parseDecision(result.stdout);
      expect(decision.block).toBe(true);
      expect(decision.reason).toContain('failed unexpectedly');
    },
    { timeout: 10000 },
  );
});
