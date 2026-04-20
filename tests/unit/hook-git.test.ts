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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandFailedError } from '../../src/cli/commands/_common/error';
import * as installSecrets from '../../src/cli/commands/_common/install/secrets';
import * as analyzeSecrets from '../../src/cli/commands/analyze/secrets';
import { gitPreCommit } from '../../src/cli/commands/hook/git-pre-commit';
import { gitPrePush } from '../../src/cli/commands/hook/git-pre-push';
import * as stdinModule from '../../src/cli/commands/hook/stdin';
import * as authResolver from '../../src/lib/auth-resolver';
import * as processLib from '../../src/lib/process';

const { EXIT_CODE_SECRETS_FOUND } = analyzeSecrets;

const FAKE_AUTH = {
  token: 'tok',
  serverUrl: 'https://sonarcloud.io',
  connectionType: 'cloud' as const,
  orgKey: 'myorg',
};

const OK_RESULT = { exitCode: 0, stdout: '', stderr: '' };
const SECRETS_RESULT = { exitCode: EXIT_CODE_SECRETS_FOUND, stdout: '', stderr: '' };

describe('gitPreCommit', () => {
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let spawnProcessSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let runSecretsBinarySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(FAKE_AUTH);
    spawnProcessSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: 'src/foo.ts\nsrc/bar.ts',
      stderr: '',
    });
    resolveSecretsBinaryPathSpy = spyOn(installSecrets, 'resolveSecretsBinaryPath').mockReturnValue(
      '/usr/bin/sonar-secrets',
    );
    runSecretsBinarySpy = spyOn(analyzeSecrets, 'runSecretsBinary').mockResolvedValue(OK_RESULT);
  });

  afterEach(() => {
    resolveAuthSpy.mockRestore();
    spawnProcessSpy.mockRestore();
    resolveSecretsBinaryPathSpy.mockRestore();
    runSecretsBinarySpy.mockRestore();
  });

  it('scans staged files when they exist', async () => {
    await gitPreCommit();

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
    const [, files] = runSecretsBinarySpy.mock.calls[0] as [string, string[], unknown];
    expect(files).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('throws CommandFailedError when secrets are found', async () => {
    runSecretsBinarySpy.mockResolvedValue(SECRETS_RESULT);

    let thrown: unknown;
    try {
      await gitPreCommit();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
  });

  it('resolves without throwing when no secrets are found', async () => {
    await gitPreCommit(); // resolves cleanly — test fails if it throws
  });

  it('skips scan when no staged files', async () => {
    spawnProcessSpy.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await gitPreCommit();

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('skips scan when auth is unavailable', async () => {
    resolveAuthSpy.mockResolvedValue(null);

    await gitPreCommit();

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('skips scan when binary is not installed', async () => {
    resolveSecretsBinaryPathSpy.mockReturnValue(null);

    await gitPreCommit();

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('throws CommandFailedError when scan throws', async () => {
    runSecretsBinarySpy.mockRejectedValue(new Error('binary crashed'));

    let thrown: unknown;
    try {
      await gitPreCommit();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
  });

  it('skips scan when git spawn throws while listing staged files', async () => {
    spawnProcessSpy.mockRejectedValue(new Error('git not found'));

    await gitPreCommit();

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });
});

describe('gitPrePush', () => {
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let spawnProcessSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let runSecretsBinarySpy: ReturnType<typeof spyOn>;
  let readGitPushRefsSpy: ReturnType<typeof spyOn>;

  const FAKE_REF = {
    localRef: 'refs/heads/main',
    localSha: 'abc123',
    remoteRef: 'refs/heads/main',
    remoteSha: '0000000000000000000000000000000000000000',
  };

  const EXISTING_BRANCH_REF = {
    ...FAKE_REF,
    remoteSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  };

  beforeEach(() => {
    resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(FAKE_AUTH);
    spawnProcessSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: 'src/foo.ts\nsrc/bar.ts',
      stderr: '',
    });
    resolveSecretsBinaryPathSpy = spyOn(installSecrets, 'resolveSecretsBinaryPath').mockReturnValue(
      '/usr/bin/sonar-secrets',
    );
    runSecretsBinarySpy = spyOn(analyzeSecrets, 'runSecretsBinary').mockResolvedValue(OK_RESULT);
    readGitPushRefsSpy = spyOn(stdinModule, 'readGitPushRefs').mockResolvedValue([FAKE_REF]);
  });

  afterEach(() => {
    resolveAuthSpy.mockRestore();
    spawnProcessSpy.mockRestore();
    resolveSecretsBinaryPathSpy.mockRestore();
    runSecretsBinarySpy.mockRestore();
    readGitPushRefsSpy.mockRestore();
  });

  it('scans files from the pushed ref', async () => {
    await gitPrePush();

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
    const [, files] = runSecretsBinarySpy.mock.calls[0] as [string, string[], unknown];
    expect(files).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('throws CommandFailedError when secrets are found', async () => {
    runSecretsBinarySpy.mockResolvedValue(SECRETS_RESULT);

    let thrown: unknown;
    try {
      await gitPrePush();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
  });

  it('resolves without throwing when no secrets found', async () => {
    await gitPrePush(); // resolves cleanly — test fails if it throws
  });

  it('skips scan when refs are empty', async () => {
    readGitPushRefsSpy.mockResolvedValue([]);

    await gitPrePush();

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('skips scan when auth is unavailable', async () => {
    resolveAuthSpy.mockResolvedValue(null);

    await gitPrePush();

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('skips scan when binary is not installed', async () => {
    resolveSecretsBinaryPathSpy.mockReturnValue(null);

    await gitPrePush();

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('skips ref when localSha is the null OID (branch deletion)', async () => {
    readGitPushRefsSpy.mockResolvedValue([
      { ...FAKE_REF, localSha: '0000000000000000000000000000000000000000' },
    ]);

    await gitPrePush();

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('skips ref when no files are returned for it', async () => {
    spawnProcessSpy.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await gitPrePush();

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('throws CommandFailedError when scan throws', async () => {
    runSecretsBinarySpy.mockRejectedValue(new Error('binary crashed'));

    let thrown: unknown;
    try {
      await gitPrePush();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
  });

  it('proceeds normally when git mktree throws (falls back to null OID as empty tree)', async () => {
    spawnProcessSpy.mockRejectedValueOnce(new Error('mktree failed'));
    // subsequent calls use the beforeEach default — rev-list + diff-tree return files

    await gitPrePush();

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
  });

  it('scans diff between remoteSha and localSha for an existing-branch push', async () => {
    readGitPushRefsSpy.mockResolvedValue([EXISTING_BRANCH_REF]);
    // spawnProcess: mktree (call 1) then git diff (call 2) — both use beforeEach default

    await gitPrePush();

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
    const [, files] = runSecretsBinarySpy.mock.calls[0] as [string, string[], unknown];
    expect(files).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('skips scan when git diff throws during existing-branch push', async () => {
    readGitPushRefsSpy.mockResolvedValue([EXISTING_BRANCH_REF]);
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123tree', stderr: '' }) // mktree
      .mockRejectedValueOnce(new Error('git diff failed')); // diff remoteSha..localSha

    await gitPrePush();

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('scans via empty-tree diff when rev-list finds no new commits', async () => {
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123tree', stderr: '' }) // mktree
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // rev-list: no commits
      .mockResolvedValue({ exitCode: 0, stdout: 'src/new.ts', stderr: '' }); // diff vs empty tree

    await gitPrePush();

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
    const [, files] = runSecretsBinarySpy.mock.calls[0] as [string, string[], unknown];
    expect(files).toEqual(['src/new.ts']);
  });

  it('skips scan when empty-tree diff throws (no new commits path)', async () => {
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'abc123tree', stderr: '' }) // mktree
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // rev-list: no commits
      .mockRejectedValue(new Error('git diff failed')); // empty-tree diff throws

    await gitPrePush();

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });
});
