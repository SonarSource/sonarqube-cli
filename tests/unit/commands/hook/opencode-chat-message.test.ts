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
import { okAsync } from '@/core/result.ts';

import * as analyzeSecrets from '../../../../src/commands/analyze/secrets.ts';
import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '../../../../src/commands/hook/hook-dependencies.ts';
import {
  OPENCODE_MASKED_MESSAGE_TEXT,
  opencodeChatMessage,
} from '../../../../src/commands/hook/opencode-chat-message.ts';
import * as stdinModule from '../../../../src/commands/hook/stdin.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';
import { mockAuthResolver } from '../../../_common/mock-auth-resolver.ts';

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
} {
  return JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim()) as {
    block: boolean;
    reason?: string;
    redactedText?: string;
  };
}

describe('opencodeChatMessage', () => {
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

  it('writes an explicit allow decision when no secrets are found', async () => {
    const result = await opencodeChatMessage(makeCtx());

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(lastDecision(stdoutSpy)).toEqual({ block: false });
    expect(result.agentSessionId).toBe('session-1');
  });

  it('replaces the whole message with the masked text when secrets are found', async () => {
    scanTextSpy.mockResolvedValue({
      exitCode: EXIT_CODE_SECRETS_FOUND,
      stdout: JSON.stringify({
        issues: [
          {
            ruleKey: 'secrets:S6290',
            description: 'GitHub token',
            location: { startLine: 1, startColumn: 12, endLine: 1, endColumn: 52 },
            maskedSecret: '***MASKED***',
          },
        ],
      }),
      stderr: '',
    });

    await opencodeChatMessage(makeCtx());

    expect(lastDecision(stdoutSpy)).toEqual({
      block: false,
      redactedText: OPENCODE_MASKED_MESSAGE_TEXT,
    });
  });

  it('masks the whole message even when the reported location covers only part of the secret', async () => {
    scanTextSpy.mockResolvedValue({
      exitCode: EXIT_CODE_SECRETS_FOUND,
      stdout: JSON.stringify({
        issues: [
          {
            ruleKey: 'secrets:S6706',
            description: 'RSA Private Key',
            location: { startLine: 1, startColumn: 6, endLine: 1, endColumn: 31 },
            maskedSecret: '---****************************',
          },
        ],
      }),
      stderr: '',
    });
    readStdinJsonSpy.mockResolvedValue({
      text: 'key = -----BEGIN KEY-----\nabcdef\n-----END KEY----- end',
      sessionID: 'session-1',
    });

    await opencodeChatMessage(makeCtx());

    const decision = lastDecision(stdoutSpy);
    expect(decision.redactedText).toBe(OPENCODE_MASKED_MESSAGE_TEXT);
    expect(decision.redactedText).not.toContain('abcdef');
  });

  it('masks the whole message when secrets are found but no issue could be parsed', async () => {
    scanTextSpy.mockResolvedValue({
      exitCode: EXIT_CODE_SECRETS_FOUND,
      stdout: 'not json',
      stderr: '',
    });

    await opencodeChatMessage(makeCtx());

    expect(lastDecision(stdoutSpy)).toEqual({
      block: false,
      redactedText: OPENCODE_MASKED_MESSAGE_TEXT,
    });
  });

  it('allows without scanning when text is empty', async () => {
    readStdinJsonSpy.mockResolvedValue({ text: '', sessionID: 'session-1' });

    await opencodeChatMessage(makeCtx());

    expect(scanTextSpy).not.toHaveBeenCalled();
    expect(lastDecision(stdoutSpy)).toEqual({ block: false });
  });

  it('blocks with the unauthenticated message when auth is unavailable', async () => {
    resolveAuthSpy.mockReturnValue(okAsync(null));

    await opencodeChatMessage(makeCtx());

    expect(scanTextSpy).not.toHaveBeenCalled();
    expect(lastDecision(stdoutSpy)).toEqual({
      block: true,
      reason: SECRETS_INACTIVE_UNAUTHENTICATED,
    });
  });

  it('blocks with the binary-missing message when the binary is not installed', async () => {
    resolveSecretsBinaryPathSpy.mockReturnValue(null);

    await opencodeChatMessage(makeCtx());

    expect(scanTextSpy).not.toHaveBeenCalled();
    expect(lastDecision(stdoutSpy)).toEqual({
      block: true,
      reason: SECRETS_INACTIVE_BINARY_MISSING,
    });
  });

  it('allows without output when stdin cannot be parsed', async () => {
    readStdinJsonSpy.mockRejectedValue(new Error('parse error'));

    await opencodeChatMessage(makeCtx());

    expect(scanTextSpy).not.toHaveBeenCalled();
    expect(lastDecision(stdoutSpy)).toEqual({ block: false });
  });

  it('blocks with the error message when the scan itself throws unexpectedly', async () => {
    scanTextSpy.mockRejectedValue(new Error('scanner crashed'));

    await opencodeChatMessage(makeCtx());

    const decision = lastDecision(stdoutSpy);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain('scanner crashed');
  });
});
