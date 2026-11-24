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

import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '@/commands/hook/hook-dependencies.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { buildLocalBinaryName } from '@/core/host/install/secrets.ts';

import { TestHarness } from '../../harness';
import { readSecretsScanArgvs } from '../../harness/recording-stub.ts';

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

  it.each(['cursor', 'devin'] as const)(
    'runs the native %s prompt scanner once per submission and still blocks secrets',
    async (agent) => {
      const server = await harness.newFakeServer().withAuthToken('token').start();
      harness.withAuth(server.baseUrl(), 'token');
      harness.state().withRecordedSecretsBinaryInstalled();
      const cwd = harness.cwd.path;
      const extraEnv: Record<string, string> =
        agent === 'devin'
          ? { DEVIN_PROJECT_DIR: cwd }
          : { CURSOR_VERSION: '1.7.2', CURSOR_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd };
      const prompt = `my token is ${GITHUB_TEST_TOKEN}`;
      const inherited = (session_id: string) =>
        harness.runWithStdin(
          'hook claude-prompt-submit',
          JSON.stringify({ prompt, cwd, session_id, hook_event_name: 'UserPromptSubmit' }),
          { extraEnv },
        );
      const native = (sessionId: string) =>
        harness.runWithStdin(
          `hook ${agent}-prompt-submit`,
          JSON.stringify(
            agent === 'devin'
              ? { prompt, session_id: sessionId }
              : { prompt, conversation_id: sessionId, hook_event_name: 'beforeSubmitPrompt' },
          ),
          { extraEnv },
        );

      expect((await inherited('before-install')).stdout).toContain('"decision":"block"');
      expect(readSecretsScanArgvs(harness)).toHaveLength(1);
      expect(
        (await harness.run(`integrate ${agent} --non-interactive`, { extraEnv })).exitCode,
      ).toBe(0);

      const decision = agent === 'devin' ? '"decision":"block"' : '"continue":false';
      expect((await inherited('one')).stdout).toBe('');
      expect((await native('one')).stdout).toContain(decision);
      expect((await native('one')).stdout).toContain(decision);
      expect((await inherited('one')).stdout).toBe('');
      const [foreignResult, nativeResult] = await Promise.all([inherited('two'), native('two')]);
      expect(foreignResult.stdout).toBe('');
      expect(nativeResult.stdout).toContain(decision);
      expect(readSecretsScanArgvs(harness)).toHaveLength(4);
    },
    { timeout: 30000 },
  );

  it(
    'retains Claude prompt blocking if Cursor registration or caller is uncertain',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('token').start();
      harness.withAuth(server.baseUrl(), 'token');
      harness.state().withRecordedSecretsBinaryInstalled();
      const cwd = harness.cwd.path;
      expect((await harness.run('integrate cursor --non-interactive')).exitCode).toBe(0);

      const extraEnv = { CURSOR_VERSION: '1.7.2', CURSOR_PROJECT_DIR: cwd };
      const invoke = (env: Record<string, string>) =>
        harness.runWithStdin(
          'hook claude-prompt-submit',
          JSON.stringify({ cwd, prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
          { extraEnv: env },
        );
      expect((await invoke({ ...extraEnv, CLAUDECODE: '1' })).stdout).toContain(
        '"decision":"block"',
      );
      expect((await invoke({ CURSOR_PROJECT_DIR: cwd })).stdout).toContain('"decision":"block"');

      const config = harness.userHome.file('.cursor', 'hooks.json').asJson();
      harness.userHome.writeFile(
        '.cursor/hooks.json',
        JSON.stringify({ ...config, enabled: false }),
      );
      expect((await invoke(extraEnv)).stdout).toContain('"decision":"block"');
      const [entry] = config.hooks.beforeSubmitPrompt;
      config.hooks.beforeSubmitPrompt = [{ ...entry, matcher: 'DifferentEvent' }];
      harness.userHome.writeFile('.cursor/hooks.json', JSON.stringify(config));
      expect((await invoke(extraEnv)).stdout).toContain('"decision":"block"');
      expect(readSecretsScanArgvs(harness)).toHaveLength(4);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 and outputs Cursor block JSON when prompt contains a secret',
    async () => {
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, 'fake-token');

      const result = await harness.runWithStdin(
        'hook cursor-prompt-submit',
        JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      );

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

      const result = await harness.runWithStdin(
        'hook cursor-prompt-submit',
        JSON.stringify({ prompt: 'please help me refactor this function' }),
      );

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

      const result = await harness.runWithStdin('hook cursor-prompt-submit', 'not valid json {{');

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

      const result = await harness.runWithStdin(
        'hook cursor-prompt-submit',
        JSON.stringify({ hook_event_name: 'beforeSubmitPrompt' }),
      );

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

      const result = await harness.runWithStdin(
        'hook cursor-prompt-submit',
        JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      );

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

      const result = await harness.runWithStdin(
        'hook cursor-prompt-submit',
        JSON.stringify({ prompt: `my token is ${GITHUB_TEST_TOKEN}` }),
      );

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

      const result = await harness.runWithStdin(
        'hook cursor-prompt-submit',
        JSON.stringify({ prompt: 'please help me refactor' }),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('"continue"');
    },
    { timeout: 10000 },
  );
});
