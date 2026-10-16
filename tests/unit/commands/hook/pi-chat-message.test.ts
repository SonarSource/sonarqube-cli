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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { type CliRuntime } from '@/core/commands/cli-runtime.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { EXIT_CODE_SECRETS_FOUND } from '@/core/config-constants.ts';
import * as installSecrets from '@/core/host/install/secrets.ts';

import * as analyzeSecrets from '../../../../src/commands/analyze/secrets.ts';
import { piChatMessage } from '../../../../src/commands/hook/pi-chat-message.ts';
import * as stdinModule from '../../../../src/commands/hook/stdin.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';
import { mockAuthResolver } from '../../../_common/mock-auth-resolver.ts';
import { useTempSonarUserHome } from '../../core/stats/_helpers.ts';

const PROMPT_TEXT = 'my token is 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, use it';

const FAKE_AUTH = new ResolvedAuth({
  token: 'tok',
  serverUrl: 'https://sonarcloud.io',
  connectionType: 'cloud',
  source: 'state' as const,
  orgKey: 'myorg',
});

let runtime: CliRuntime;

function makeCtx() {
  return new CommandInvocationContext(new FakeConsole(), undefined, runtime);
}

function lastDecision(stdoutSpy: ReturnType<typeof spyOn>): {
  block: boolean;
  reason?: string;
  redactedText?: string;
  secretsFound?: number;
} {
  return JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim()) as {
    block: boolean;
    reason?: string;
    redactedText?: string;
    secretsFound?: number;
  };
}

describe('piChatMessage', () => {
  useTempSonarUserHome('sonar-pi-chat-message-');

  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let scanTextSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const mocked = mockAuthResolver(FAKE_AUTH);
    runtime = mocked.runtime;
    resolveAuthSpy = mocked.resolveAuthSpy;
    readStdinJsonSpy = spyOn(stdinModule, 'readStdinJson').mockResolvedValue({
      text: PROMPT_TEXT,
      sessionID: 'session-1',
    });
    resolveSecretsBinaryPathSpy = spyOn(installSecrets, 'resolveSecretsBinaryPath').mockReturnValue(
      '/usr/bin/sonar-secrets',
    );
    scanTextSpy = spyOn(analyzeSecrets, 'runSecretsBinaryOnText').mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    readStdinJsonSpy.mockRestore();
    resolveSecretsBinaryPathSpy.mockRestore();
    scanTextSpy.mockRestore();
  });

  it('masks multiple secrets on the same line right-to-left without shifting earlier columns', async () => {
    scanTextSpy.mockResolvedValue({
      exitCode: EXIT_CODE_SECRETS_FOUND,
      stdout: JSON.stringify({
        issues: [
          {
            ruleKey: 'secrets:S1',
            description: 'first',
            location: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 3 },
            maskedSecret: 'X',
          },
          {
            ruleKey: 'secrets:S2',
            description: 'second',
            location: { startLine: 1, startColumn: 4, endLine: 1, endColumn: 7 },
            maskedSecret: 'YYYYY',
          },
        ],
      }),
      stderr: '',
    });
    readStdinJsonSpy.mockResolvedValue({ text: 'foo bar', sessionID: 'session-1' });

    await piChatMessage(makeCtx());

    expect(lastDecision(stdoutSpy).redactedText).toBe('X YYYYY');
  });

  it('blocks when a reported secret has no location or mask to redact it with', async () => {
    scanTextSpy.mockResolvedValue({
      exitCode: EXIT_CODE_SECRETS_FOUND,
      stdout: JSON.stringify({
        issues: [
          {
            ruleKey: 'secrets:S1',
            description: 'unmaskable finding',
          },
        ],
      }),
      stderr: '',
    });

    await piChatMessage(makeCtx());

    const decision = lastDecision(stdoutSpy);
    expect(decision.block).toBe(true);
    expect(decision.redactedText).toBeUndefined();
  });

  it.each([
    ['a line that does not exist', { startLine: 5, startColumn: 0, endLine: 5, endColumn: 3 }],
    [
      'an end column past the end of the text',
      { startLine: 1, startColumn: 0, endLine: 1, endColumn: 99 },
    ],
    ['an end before its start', { startLine: 1, startColumn: 5, endLine: 1, endColumn: 2 }],
  ])('blocks when a reported secret has %s', async (_name, location) => {
    scanTextSpy.mockResolvedValue({
      exitCode: EXIT_CODE_SECRETS_FOUND,
      stdout: JSON.stringify({
        issues: [
          { ruleKey: 'secrets:S1', description: 'bad location', location, maskedSecret: '***' },
        ],
      }),
      stderr: '',
    });
    readStdinJsonSpy.mockResolvedValue({ text: 'foo bar', sessionID: 'session-1' });

    await piChatMessage(makeCtx());

    const decision = lastDecision(stdoutSpy);
    expect(decision.block).toBe(true);
    expect(decision.redactedText).toBeUndefined();
  });

  it('blocks when the scanner exits with a code that is neither clean nor secrets found', async () => {
    scanTextSpy.mockResolvedValue({
      exitCode: 2,
      stdout: JSON.stringify({ issues: [] }),
      stderr: '',
    });

    await piChatMessage(makeCtx());

    const decision = lastDecision(stdoutSpy);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain('exit code 2');
  });
});
