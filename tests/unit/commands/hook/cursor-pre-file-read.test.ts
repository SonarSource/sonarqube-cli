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
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import * as authResolver from '@/core/auth/auth-resolver.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { CURSOR_IGNORE_FILE } from '@/core/config-constants.ts';
import * as installSecrets from '@/core/host/install/secrets.ts';

import * as analyzeSecrets from '../../../../src/commands/analyze/secrets.ts';
import { cursorPreFileRead } from '../../../../src/commands/hook/cursor-pre-file-read.ts';
import {
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '../../../../src/commands/hook/hook-dependencies.ts';
import * as stdinModule from '../../../../src/commands/hook/stdin.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

const TEST_FILE = '/sonar-test/secret.ts';
const SECRET_CONTENT = 'const secret = "ghp_test";';
const { EXIT_CODE_SECRETS_FOUND } = analyzeSecrets;

function makeCtx() {
  return new CommandInvocationContext(new FakeConsole());
}

describe('cursorPreFileRead', () => {
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
      file_path: TEST_FILE,
      content: SECRET_CONTENT,
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

  it('blocks with deny JSON when secrets are found in payload content', async () => {
    runSecretsBinaryOnTextSpy.mockResolvedValue({
      exitCode: EXIT_CODE_SECRETS_FOUND,
      stdout: '',
      stderr: '',
    });

    const ctx = makeCtx();
    await cursorPreFileRead(ctx);

    expect(runSecretsBinaryOnTextSpy).toHaveBeenCalledWith(
      '/usr/bin/sonar-secrets',
      SECRET_CONTENT,
      expect.any(Object),
    );
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.permission).toBe('deny');
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(ctx.telemetryFacts()).toHaveLength(1);
  });

  it('returns without scanning when file path and content are missing', async () => {
    readStdinJsonSpy.mockResolvedValue({});

    await cursorPreFileRead(makeCtx());

    expect(runSecretsBinaryOnTextSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('scans file from disk when content is omitted but file_path is present', async () => {
    readStdinJsonSpy.mockResolvedValue({ file_path: TEST_FILE });

    await cursorPreFileRead(makeCtx());

    expect(readFileSpy).toHaveBeenCalledWith(TEST_FILE, 'utf-8');
    expect(runSecretsBinaryOnTextSpy).toHaveBeenCalledWith(
      '/usr/bin/sonar-secrets',
      SECRET_CONTENT,
      expect.any(Object),
    );
  });

  it('denies with the unauthenticated message and exits 2 when auth is unavailable', async () => {
    resolveAuthSpy.mockResolvedValue(null);

    await cursorPreFileRead(makeCtx());

    expect(runSecretsBinaryOnTextSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.permission).toBe('deny');
    expect(output.user_message).toBe(SECRETS_INACTIVE_UNAUTHENTICATED);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('denies with the binary-missing message and exits 2 when the analyzer is not installed', async () => {
    resolveSecretsBinaryPathSpy.mockReturnValue(null);

    await cursorPreFileRead(makeCtx());

    expect(runSecretsBinaryOnTextSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.permission).toBe('deny');
    expect(output.user_message).toBe(SECRETS_INACTIVE_BINARY_MISSING);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

describe('cursorPreFileRead — .cursorignore side effect', () => {
  let projectRoot: string;
  let stdoutSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let readStdinJsonSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let runSecretsBinaryOnTextSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cursor-pre-file-read-'));

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
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, SECRET_CONTENT);

    readStdinJsonSpy.mockResolvedValue({
      file_path: filePath,
      content: SECRET_CONTENT,
      workspace_roots: [projectRoot],
    });

    await cursorPreFileRead(makeCtx());

    const ignoreContent = readFileSync(join(projectRoot, CURSOR_IGNORE_FILE), 'utf-8');
    expect(ignoreContent).toContain('src/secret.ts');
  });

  it('does not append to .cursorignore when no file path is available', async () => {
    readStdinJsonSpy.mockResolvedValue({ content: SECRET_CONTENT, workspace_roots: [projectRoot] });

    await cursorPreFileRead(makeCtx());

    expect(() => readFileSync(join(projectRoot, CURSOR_IGNORE_FILE))).toThrow();
  });
});
