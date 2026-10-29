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

const TEST_SECRET = 'sqp_b4556a16fa2d28519d2451a911d2e073024010bc';
const SECRETS_REDACTED_NOTICE =
  '[SonarQube] Secrets were redacted from this message. Let the user know that SonarQube redacted them.';
const SECRETS_BLOCKED_NOTICE = 'Let the user know that SonarQube blocked this message.';
const TEST_TIMEOUT = { timeout: 60000 };

interface HookOutput {
  decision?: 'block';
  reason?: string;
  modifiedTransformedPrompt?: string;
}

describe('sonar hook agent-secrets-masking', () => {
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

  async function runHook(agent: string, payload: unknown): Promise<HookOutput> {
    const result = await harness.runWithStdin(
      `hook agent-secrets-masking --agent ${agent}`,
      JSON.stringify(payload),
    );
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.trim() || '{}') as HookOutput;
  }

  it.each(['', 'unsupported', 'constructor', '__proto__'])(
    'stops before scanning for a missing or unknown agent: %s',
    async (agent) => {
      const result = await harness.runWithStdin(
        `hook agent-secrets-masking${agent ? ` --agent ${agent}` : ''}`,
        JSON.stringify({ tool_response: 'Some output.' }),
      );
      expect(result.exitCode === 0).toBe(agent !== '');
      expect(result.stdout.trim()).toBe('');
      if (!agent) expect(result.stderr).toContain('--agent');
    },
    TEST_TIMEOUT,
  );

  for (const invocation of [
    {
      agent: 'codex',
      stdin: (text: string) => ({ tool_response: text, session_id: 'session-1' }),
      outputField: 'reason' as const,
      expected: (text: string): HookOutput => ({ decision: 'block', reason: text }),
    },
    {
      agent: 'copilot',
      stdin: (text: string) => ({ transformedPrompt: text, sessionId: 'session-1' }),
      outputField: 'modifiedTransformedPrompt' as const,
      expected: (text: string): HookOutput => ({ modifiedTransformedPrompt: text }),
    },
  ]) {
    describe(invocation.agent, () => {
      async function run(text: string): Promise<string | undefined> {
        const output = await runHook(invocation.agent, invocation.stdin(text));
        const replacement = output[invocation.outputField];
        expect(output).toEqual(replacement === undefined ? {} : invocation.expected(replacement));
        return replacement;
      }

      it.each([{}, null, invocation.stdin('')])(
        'allows missing or empty input without authentication: %j',
        async (payload) => {
          expect(await runHook(invocation.agent, payload)).toEqual({});
        },
        TEST_TIMEOUT,
      );

      it(
        'leaves clean input untouched',
        async () => {
          await authenticate();
          harness.state().withSecretsBinaryInstalled();
          expect(await run('No secrets here.')).toBeUndefined();
        },
        TEST_TIMEOUT,
      );

      it(
        'masks multiple secrets, adds one notice, and allows a clean follow-up',
        async () => {
          await authenticate();
          harness.state().withSecretsBinaryInstalled();
          const replacement = await run(
            `First token: ${TEST_SECRET}\nSecond token: ${TEST_SECRET}\nDone.`,
          );
          expect(replacement).not.toContain(TEST_SECRET);
          expect(replacement).toStartWith('First token: ');
          expect(replacement).toContain('\nSecond token: ');
          expect(replacement).toEndWith(`\nDone.\n\n${SECRETS_REDACTED_NOTICE}`);
          expect(replacement?.split(SECRETS_REDACTED_NOTICE)).toHaveLength(2);
          expect(await run('Done.')).toBeUndefined();
        },
        TEST_TIMEOUT,
      );

      it(
        'replaces the entire input when authentication is missing',
        async () => {
          harness.state().withSecretsBinaryInstalled();
          const replacement = await run(`Use ${TEST_SECRET} to publish.`);
          expect(replacement).toStartWith('[SonarQube] Message blocked:');
          expect(replacement).toContain(SECRETS_INACTIVE_UNAUTHENTICATED);
          expect(replacement).not.toContain(TEST_SECRET);
          expect(replacement).not.toContain('to publish');
          expect(replacement).toEndWith(SECRETS_BLOCKED_NOTICE);
        },
        TEST_TIMEOUT,
      );

      it(
        'replaces the input when the scanner is missing',
        async () => {
          await authenticate();
          const replacement = await run(`Use ${TEST_SECRET}`);
          expect(replacement).toContain(SECRETS_INACTIVE_BINARY_MISSING);
          expect(replacement).not.toContain(TEST_SECRET);
          expect(replacement).toEndWith(SECRETS_BLOCKED_NOTICE);
        },
        TEST_TIMEOUT,
      );

      it(
        'fails closed when the scanner cannot start',
        async () => {
          await authenticate();
          harness.cliHome.writeFile(
            `bin/${buildLocalBinaryName(detectPlatform())}`,
            'not-a-binary',
          );
          const replacement = await run(`Use ${TEST_SECRET}`);
          expect(replacement).toStartWith(
            '[SonarQube] Message blocked: could not verify this message for secrets',
          );
          expect(replacement).toMatch(/for secrets \([^)]+\)/);
          expect(replacement).not.toContain('(scanner error)');
          expect(replacement).not.toContain(TEST_SECRET);
          expect(replacement).toEndWith(SECRETS_BLOCKED_NOTICE);
        },
        TEST_TIMEOUT,
      );

      it(
        'silently allows malformed hook JSON',
        async () => {
          const result = await harness.runWithStdin(
            `hook agent-secrets-masking --agent ${invocation.agent}`,
            'invalid json',
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout.trim()).toBe('');
        },
        TEST_TIMEOUT,
      );
    });
  }
});
