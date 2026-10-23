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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '@/commands/hook/hook-dependencies.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalBinaryName } from '@/core/host/install/secrets.ts';

import { TestHarness } from '../../harness';

const GITHUB_TEST_TOKEN = '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';
const NOTICE =
  '[SonarQube] Secrets were redacted from this message. Let the user know that SonarQube redacted them.';
const BLOCKED_NOTICE = 'Let the user know that SonarQube blocked this message.';

describe('sonar hook copilot-prompt-transformed', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function authenticate(): Promise<void> {
    const server = await harness.newFakeServer().withAuthToken('tok').start();
    harness.withAuth(server.baseUrl(), 'tok');
  }

  async function run(payload: unknown): Promise<{ modifiedTransformedPrompt?: string }> {
    const result = await harness.runWithStdin(
      'hook copilot-prompt-transformed',
      JSON.stringify(payload),
    );
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.trim()) as { modifiedTransformedPrompt?: string };
  }

  it.each([{}, null, { transformedPrompt: '' }, { transformedPrompt: 42 }])(
    'silently allows missing or invalid transformedPrompt: %j',
    async (payload) => {
      expect(await run(payload)).toEqual({});
    },
    { timeout: 15000 },
  );

  it(
    'leaves a clean prompt unchanged',
    async () => {
      await authenticate();
      harness.state().withSecretsBinaryInstalled();
      expect(
        await run({ transformedPrompt: 'Please refactor this function.', sessionId: 'session-1' }),
      ).toEqual({});
    },
    { timeout: 30000 },
  );

  it(
    'redacts multiple secrets, adds one notice, and allows a clean follow-up in the same session',
    async () => {
      await authenticate();
      harness.state().withSecretsBinaryInstalled();
      const result = await run({
        transformedPrompt: `First token: ${GITHUB_TEST_TOKEN}\nSecond token: ${GITHUB_TEST_TOKEN}\nPlease help.`,
        sessionId: 'session-1',
      });
      expect(result.modifiedTransformedPrompt).not.toContain(GITHUB_TEST_TOKEN);
      expect(result.modifiedTransformedPrompt).toStartWith('First token: ');
      expect(result.modifiedTransformedPrompt).toContain('\nSecond token: ');
      expect(result.modifiedTransformedPrompt).toEndWith(`\nPlease help.\n\n${NOTICE}`);
      expect(result.modifiedTransformedPrompt?.split(NOTICE)).toHaveLength(2);
      expect(
        await run({ transformedPrompt: 'Explain the change.', sessionId: 'session-1' }),
      ).toEqual({});
    },
    { timeout: 60000 },
  );

  it(
    'replaces the entire prompt when authentication is missing',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      const result = await run({ transformedPrompt: `Use ${GITHUB_TEST_TOKEN} to publish.` });
      expect(result.modifiedTransformedPrompt).toStartWith('[SonarQube] Message blocked:');
      expect(result.modifiedTransformedPrompt).toContain(SECRETS_INACTIVE_UNAUTHENTICATED);
      expect(result.modifiedTransformedPrompt).not.toContain(GITHUB_TEST_TOKEN);
      expect(result.modifiedTransformedPrompt).not.toContain('to publish');
      expect(result.modifiedTransformedPrompt).toEndWith(BLOCKED_NOTICE);
    },
    { timeout: 15000 },
  );

  it(
    'replaces the prompt when the scanner is missing',
    async () => {
      await authenticate();
      const result = await run({ transformedPrompt: `Use ${GITHUB_TEST_TOKEN}` });
      expect(result.modifiedTransformedPrompt).toContain(SECRETS_INACTIVE_BINARY_MISSING);
      expect(result.modifiedTransformedPrompt).not.toContain(GITHUB_TEST_TOKEN);
      expect(result.modifiedTransformedPrompt).toEndWith(BLOCKED_NOTICE);
    },
    { timeout: 15000 },
  );

  it(
    'replaces the prompt when the scanner cannot be started',
    async () => {
      await authenticate();
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      const result = await run({ transformedPrompt: `Use ${GITHUB_TEST_TOKEN}` });
      expect(result.modifiedTransformedPrompt).toStartWith(
        '[SonarQube] Message blocked: could not verify this message for secrets',
      );
      expect(result.modifiedTransformedPrompt).not.toContain(GITHUB_TEST_TOKEN);
      expect(result.modifiedTransformedPrompt).toEndWith(BLOCKED_NOTICE);
    },
    { timeout: 15000 },
  );

  it(
    'silently allows malformed JSON without failing the hook',
    async () => {
      const result = await harness.runWithStdin(
        'hook copilot-prompt-transformed',
        'not valid json',
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({});
    },
    { timeout: 15000 },
  );
});
