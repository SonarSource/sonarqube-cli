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

import * as fs from 'node:fs';

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
import { opencodePreToolUse } from '../../../../src/commands/hook/opencode-pre-tool-use.ts';
import * as stdinModule from '../../../../src/commands/hook/stdin.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';
import { mockAuthResolver } from '../../../_common/mock-auth-resolver.ts';

const TEST_FILE = '/sonar-test/test.ts';

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

function lastDecision(stdoutSpy: ReturnType<typeof spyOn>): { block: boolean; reason?: string } {
  return JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim()) as {
    block: boolean;
    reason?: string;
  };
}

describe('opencodePreToolUse', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let scanFilesSpy: ReturnType<typeof spyOn>;
  let existsSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const mocked = mockAuthResolver(FAKE_AUTH);
    runtime = mocked.runtime;
    resolveAuthSpy = mocked.resolveAuthSpy;
    readStdinJsonSpy = spyOn(stdinModule, 'readStdinJson').mockResolvedValue({
      tool: 'read',
      filePath: TEST_FILE,
      sessionID: 'session-1',
    });
    resolveSecretsBinaryPathSpy = spyOn(installSecrets, 'resolveSecretsBinaryPath').mockReturnValue(
      '/usr/bin/sonar-secrets',
    );
    scanFilesSpy = spyOn(analyzeSecrets, 'runSecretsBinary').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    readStdinJsonSpy.mockRestore();
    resolveSecretsBinaryPathSpy.mockRestore();
    scanFilesSpy.mockRestore();
    existsSyncSpy.mockRestore();
  });

  it('writes an explicit allow decision when no secrets are found', async () => {
    const result = await opencodePreToolUse(makeCtx());

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(lastDecision(stdoutSpy)).toEqual({ block: false });
    expect(result.agentSessionId).toBe('session-1');
  });

  it('writes a block decision when secrets are found', async () => {
    scanFilesSpy.mockResolvedValue({ exitCode: EXIT_CODE_SECRETS_FOUND, stdout: '', stderr: '' });

    await opencodePreToolUse(makeCtx());

    const decision = lastDecision(stdoutSpy);
    expect(decision.block).toBe(true);
    expect(decision.reason).toContain(TEST_FILE);
  });

  it('allows without scanning when the tool is not read', async () => {
    readStdinJsonSpy.mockResolvedValue({ tool: 'edit', filePath: TEST_FILE });

    await opencodePreToolUse(makeCtx());

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(lastDecision(stdoutSpy)).toEqual({ block: false });
  });

  it('allows without scanning when the file does not exist', async () => {
    existsSyncSpy.mockReturnValue(false);

    await opencodePreToolUse(makeCtx());

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(lastDecision(stdoutSpy)).toEqual({ block: false });
  });

  it('blocks with the unauthenticated message when auth is unavailable', async () => {
    resolveAuthSpy.mockReturnValue(okAsync(null));

    await opencodePreToolUse(makeCtx());

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(lastDecision(stdoutSpy)).toEqual({
      block: true,
      reason: SECRETS_INACTIVE_UNAUTHENTICATED,
    });
  });

  it('blocks with the binary-missing message when the binary is not installed', async () => {
    resolveSecretsBinaryPathSpy.mockReturnValue(null);

    await opencodePreToolUse(makeCtx());

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(lastDecision(stdoutSpy)).toEqual({
      block: true,
      reason: SECRETS_INACTIVE_BINARY_MISSING,
    });
  });

  it('allows without output when stdin cannot be parsed', async () => {
    readStdinJsonSpy.mockRejectedValue(new Error('parse error'));

    await opencodePreToolUse(makeCtx());

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(lastDecision(stdoutSpy)).toEqual({ block: false });
  });

  it('allows when the scan itself throws', async () => {
    scanFilesSpy.mockRejectedValue(new Error('scanner crashed'));

    await opencodePreToolUse(makeCtx());

    expect(lastDecision(stdoutSpy)).toEqual({ block: false });
  });
});
