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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import * as installSecrets from '../../../../../src/cli/commands/_common/install/secrets';
import * as analyzeSecrets from '../../../../../src/cli/commands/analyze/secrets';
import { cursorPreToolUse } from '../../../../../src/cli/commands/hook/cursor-pre-tool-use';
import * as stdinModule from '../../../../../src/cli/commands/hook/stdin';
import * as authResolver from '../../../../../src/lib/auth-resolver';
import { CURSOR_IGNORE_FILE } from '../../../../../src/lib/config-constants';

const TEST_FILE = '/sonar-test/secret.ts';
const SECRET_CONTENT = 'const secret = "ghp_test";';
const { EXIT_CODE_SECRETS_FOUND } = analyzeSecrets;

describe('cursorPreToolUse', () => {
  let stdoutSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let runSecretsBinaryOnTextSpy: ReturnType<typeof spyOn>;
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let readFileSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(
      (_data: unknown, cb?: unknown) => {
        if (typeof cb === 'function') cb();
        return true;
      },
    );
    exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
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
    runSecretsBinaryOnTextSpy = spyOn(analyzeSecrets, 'runSecretsBinaryOnText').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    existsSyncSpy = spyOn(fs, 'existsSync').mockReturnValue(true);
    readFileSpy = spyOn(fsPromises, 'readFile').mockResolvedValue(SECRET_CONTENT);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    readStdinJsonSpy.mockRestore();
    resolveSecretsBinaryPathSpy.mockRestore();
    runSecretsBinaryOnTextSpy.mockRestore();
    existsSyncSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it('blocks with preToolUse deny JSON when secrets are found', async () => {
    runSecretsBinaryOnTextSpy.mockResolvedValue({
      exitCode: EXIT_CODE_SECRETS_FOUND,
      stdout: '',
      stderr: '',
    });

    await cursorPreToolUse();

    expect(readFileSpy).toHaveBeenCalledWith(TEST_FILE, 'utf-8');
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.permission).toBe('deny');
    expect(output.user_message).toContain(TEST_FILE);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('returns without scanning when tool_name is not Read', async () => {
    readStdinJsonSpy.mockResolvedValue({
      tool_name: 'Grep',
      tool_input: { file_path: TEST_FILE },
    });

    await cursorPreToolUse();

    expect(readFileSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('falls back to tool_input.path when file_path is absent', async () => {
    readStdinJsonSpy.mockResolvedValue({
      tool_name: 'Read',
      tool_input: { path: TEST_FILE },
    });

    await cursorPreToolUse();

    expect(readFileSpy).toHaveBeenCalledWith(TEST_FILE, 'utf-8');
  });
});

describe('cursorPreToolUse — .cursorignore side effect', () => {
  let projectRoot: string;
  let stdoutSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let runSecretsBinaryOnTextSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cursor-pre-tool-use-'));
    mkdirSync(join(projectRoot, '.cursor'));

    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(
      (_data: unknown, cb?: unknown) => {
        if (typeof cb === 'function') cb();
        return true;
      },
    );
    exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue({
      token: 'tok',
      serverUrl: 'https://sonarcloud.io',
      connectionType: 'cloud',
      orgKey: 'myorg',
    });
    readStdinJsonSpy = spyOn(stdinModule, 'readStdinJson');
    resolveSecretsBinaryPathSpy = spyOn(installSecrets, 'resolveSecretsBinaryPath').mockReturnValue(
      '/usr/bin/sonar-secrets',
    );
    runSecretsBinaryOnTextSpy = spyOn(analyzeSecrets, 'runSecretsBinaryOnText').mockResolvedValue({
      exitCode: EXIT_CODE_SECRETS_FOUND,
      stdout: '',
      stderr: '',
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    resolveAuthSpy.mockRestore();
    readStdinJsonSpy.mockRestore();
    resolveSecretsBinaryPathSpy.mockRestore();
    runSecretsBinaryOnTextSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('appends file path to .cursorignore on deny', async () => {
    const filePath = join(projectRoot, 'src', 'secret.ts');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(filePath, SECRET_CONTENT);

    readStdinJsonSpy.mockResolvedValue({
      tool_name: 'Read',
      tool_input: { file_path: filePath },
    });

    await cursorPreToolUse();

    const ignoreContent = readFileSync(join(projectRoot, CURSOR_IGNORE_FILE), 'utf-8');
    expect(ignoreContent).toContain('src/secret.ts');
  });
});
