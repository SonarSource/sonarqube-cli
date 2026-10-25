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
const NOTICE =
  '[SonarQube] Secrets were redacted from this message. Let the user know that SonarQube redacted them.';

interface HookOutput {
  decision?: 'block';
  reason?: string;
}

describe('sonar hook codex-post-tool-use-secrets', () => {
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

  async function run(payload: unknown): Promise<HookOutput> {
    const result = await harness.runWithStdin(
      'hook codex-post-tool-use-secrets',
      JSON.stringify(payload),
    );
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.trim()) as HookOutput;
  }

  it.each([{}, null, { tool_response: null }, { tool_response: '' }])(
    'allows missing or empty output without requiring authentication: %j',
    async (payload) => {
      expect(await run(payload)).toEqual({});
    },
    { timeout: 15000 },
  );

  it.each([
    'No secrets here.',
    { content: [{ type: 'text', text: 'File contents' }], isError: false, count: 2, next: null },
  ])(
    'leaves clean output untouched: %j',
    async (toolResponse) => {
      await authenticate();
      harness.state().withSecretsBinaryInstalled();
      expect(await run({ tool_response: toolResponse, session_id: 'session-1' })).toEqual({});
    },
    { timeout: 30000 },
  );

  it(
    'replaces secret output with masked text and one notice, then allows a clean follow-up',
    async () => {
      await authenticate();
      harness.state().withSecretsBinaryInstalled();
      const result = await run({
        tool_response: `First token: ${TEST_SECRET}\nSecond token: ${TEST_SECRET}\nDone.`,
        session_id: 'session-1',
      });
      expect(result.decision).toBe('block');
      expect(result.reason).not.toContain(TEST_SECRET);
      expect(result.reason).toStartWith('First token: ');
      expect(result.reason).toContain('\nSecond token: ');
      expect(result.reason).toEndWith(`\nDone.\n\n${NOTICE}`);
      expect(result.reason?.split(NOTICE)).toHaveLength(2);
      expect(await run({ tool_response: 'Done.', session_id: 'session-1' })).toEqual({});
    },
    { timeout: 60000 },
  );

  it(
    'masks secrets nested in MCP content and replaces the object with text feedback',
    async () => {
      await authenticate();
      harness.state().withSecretsBinaryInstalled();
      const result = await run({
        tool_response: {
          content: [{ type: 'text', text: `Token: ${TEST_SECRET}\nEnd.` }],
          isError: false,
          structuredContent: { count: 1, next: null },
        },
      });
      expect(result.decision).toBe('block');
      expect(result.reason).not.toContain(TEST_SECRET);
      expect(result.reason).toStartWith('content: type: text\ntext: Token: ');
      expect(result.reason).toContain(
        '\nEnd.\nisError: false\nstructuredContent: count: 1\nnext: null',
      );
      expect(result.reason).toEndWith(`\n\n${NOTICE}`);
    },
    { timeout: 30000 },
  );

  it(
    'blocks the original output when authentication is missing',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      const result = await run({ tool_response: TEST_SECRET });
      expect(result.decision).toBe('block');
      expect(result.reason).toContain(SECRETS_INACTIVE_UNAUTHENTICATED);
      expect(result.reason).not.toContain(TEST_SECRET);
    },
    { timeout: 15000 },
  );

  it(
    'blocks the original output when the scanner is missing',
    async () => {
      await authenticate();
      const result = await run({ tool_response: TEST_SECRET });
      expect(result.decision).toBe('block');
      expect(result.reason).toContain(SECRETS_INACTIVE_BINARY_MISSING);
      expect(result.reason).not.toContain(TEST_SECRET);
    },
    { timeout: 15000 },
  );

  it(
    'fails closed when the scanner cannot start',
    async () => {
      await authenticate();
      harness.cliHome.writeFile(`bin/${buildLocalBinaryName(detectPlatform())}`, 'not-a-binary');
      const result = await run({ tool_response: TEST_SECRET });
      expect(result.decision).toBe('block');
      expect(result.reason).toContain('could not verify this message for secrets (');
      expect(result.reason).toMatch(/for secrets \([^)]+\)/);
      expect(result.reason).not.toContain('(scanner error)');
      expect(result.reason).not.toContain(TEST_SECRET);
    },
    { timeout: 15000 },
  );

  it(
    'silently allows malformed hook JSON',
    async () => {
      const result = await harness.runWithStdin('hook codex-post-tool-use-secrets', 'invalid json');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({});
    },
    { timeout: 15000 },
  );
});
