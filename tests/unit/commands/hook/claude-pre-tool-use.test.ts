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

import * as fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import * as authResolver from '@/core/auth/auth-resolver.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import * as installSecrets from '@/core/host/install/secrets.ts';

import * as analyzeSecrets from '../../../../src/commands/analyze/secrets.ts';
import { claudePreToolUse } from '../../../../src/commands/hook/claude-pre-tool-use.ts';
import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '../../../../src/commands/hook/hook-dependencies.ts';
import * as stdinModule from '../../../../src/commands/hook/stdin.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

const TEST_FILE = '/sonar-test/test.ts';
const { EXIT_CODE_SECRETS_FOUND } = analyzeSecrets;

function makeCtx() {
  return new CommandInvocationContext(new FakeConsole());
}

describe('claudePreToolUse', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let scanFilesSpy: ReturnType<typeof spyOn>;
  let existsSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
      orgKey: 'myorg',
    });
    readStdinJsonSpy = spyOn(stdinModule, 'readStdinJson').mockResolvedValue({
      tool_name: 'Read',
      tool_input: { file_path: TEST_FILE },
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

  it('writes deny JSON to stdout when secrets are found', async () => {
    scanFilesSpy.mockResolvedValue({ exitCode: EXIT_CODE_SECRETS_FOUND, stdout: '', stderr: '' });

    await claudePreToolUse(makeCtx());

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  });

  it('includes the file path in the deny reason', async () => {
    scanFilesSpy.mockResolvedValue({ exitCode: EXIT_CODE_SECRETS_FOUND, stdout: '', stderr: '' });

    await claudePreToolUse(makeCtx());

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(TEST_FILE);
  });

  it('writes nothing when no secrets are found', async () => {
    await claudePreToolUse(makeCtx());
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when tool_name is not Read', async () => {
    readStdinJsonSpy.mockResolvedValue({ tool_name: 'Edit', tool_input: { file_path: TEST_FILE } });

    await claudePreToolUse(makeCtx());

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('denies with the unauthenticated message when auth is unavailable', async () => {
    resolveAuthSpy.mockResolvedValue(null);

    await claudePreToolUse(makeCtx());

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toBe(
      SECRETS_INACTIVE_UNAUTHENTICATED,
    );
  });

  it('denies with the binary-missing message when binary is not installed', async () => {
    resolveSecretsBinaryPathSpy.mockReturnValue(null);

    await claudePreToolUse(makeCtx());

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toBe(
      SECRETS_INACTIVE_BINARY_MISSING,
    );
  });

  it('returns without output when file does not exist', async () => {
    existsSyncSpy.mockReturnValue(false);

    await claudePreToolUse(makeCtx());

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when stdin cannot be parsed', async () => {
    readStdinJsonSpy.mockRejectedValue(new Error('parse error'));

    await claudePreToolUse(makeCtx());

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
