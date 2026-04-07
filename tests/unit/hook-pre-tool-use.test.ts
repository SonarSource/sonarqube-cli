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

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as authResolver from '../../src/lib/auth-resolver';
import * as stdinModule from '../../src/cli/commands/hook/stdin';
import * as installSecrets from '../../src/cli/commands/_common/install/secrets';
import * as analyzeSecrets from '../../src/cli/commands/analyze/secrets';
import { claudePreToolUse } from '../../src/cli/commands/hook/claude-pre-tool-use';

const TEST_FILE = '/sonar-test/test.ts';
const { EXIT_CODE_SECRETS_FOUND } = analyzeSecrets;

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

    await claudePreToolUse();

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  });

  it('includes the file path in the deny reason', async () => {
    scanFilesSpy.mockResolvedValue({ exitCode: EXIT_CODE_SECRETS_FOUND, stdout: '', stderr: '' });

    await claudePreToolUse();

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(TEST_FILE);
  });

  it('writes nothing when no secrets are found', async () => {
    await claudePreToolUse();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when tool_name is not Read', async () => {
    readStdinJsonSpy.mockResolvedValue({ tool_name: 'Edit', tool_input: { file_path: TEST_FILE } });

    await claudePreToolUse();

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when auth is unavailable', async () => {
    resolveAuthSpy.mockResolvedValue(null);

    await claudePreToolUse();

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when binary is not installed', async () => {
    resolveSecretsBinaryPathSpy.mockReturnValue(null);

    await claudePreToolUse();

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when file does not exist', async () => {
    existsSyncSpy.mockReturnValue(false);

    await claudePreToolUse();

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns without output when stdin cannot be parsed', async () => {
    readStdinJsonSpy.mockRejectedValue(new Error('parse error'));

    await claudePreToolUse();

    expect(scanFilesSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });
});
