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

import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { type CliRuntime } from '@/core/commands/cli-runtime.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { EXIT_CODE_SECRETS_FOUND } from '@/core/config-constants.ts';
import * as installSecrets from '@/core/host/install/secrets.ts';
import * as processLib from '@/core/process/process.ts';
import { okAsync } from '@/core/result.ts';

import * as analyzeSecrets from '../../../../src/commands/analyze/secrets.ts';
import { gitPreCommit } from '../../../../src/commands/hook/git-pre-commit.ts';
import { gitPrePush, REMOTE_NAME_ENV } from '../../../../src/commands/hook/git-pre-push.ts';
import {
  HOOK_INACTIVE_UNAUTHENTICATED,
  MissingDependenciesError,
  SECRETS_INACTIVE_BINARY_MISSING,
  SECRETS_INACTIVE_UNAUTHENTICATED,
} from '../../../../src/commands/hook/hook-dependencies.ts';
import * as stdinModule from '../../../../src/commands/hook/stdin.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';
import { mockAuthResolver } from '../../../_common/mock-auth-resolver.ts';

let fake: FakeConsole;
let runtime: CliRuntime;

const FAKE_AUTH = new ResolvedAuth({
  token: 'tok',
  serverUrl: 'https://sonarcloud.io',
  connectionType: 'cloud' as const,
  source: 'state' as const,
  orgKey: 'myorg',
});

const OK_RESULT = { exitCode: 0, stdout: '', stderr: '' };
const SECRETS_RESULT = { exitCode: EXIT_CODE_SECRETS_FOUND, stdout: '', stderr: '' };

function makeCtx() {
  return new CommandInvocationContext(fake, undefined, runtime);
}

const SECRETS_RESULT_WITH_ISSUES = {
  exitCode: EXIT_CODE_SECRETS_FOUND,
  stdout: JSON.stringify({
    issues: [
      {
        ruleKey: 'secrets:S6640',
        description: 'AWS key detected',
        file: 'src/config.ts',
        location: { startLine: 12, startColumn: 1, endLine: 12, endColumn: 40 },
        maskedSecret: 'AKIA****',
      },
    ],
  }),
  stderr: '',
};

/** Args of the first `git <subcommand>` spawn recorded by the spy, if any. */
function gitArgsFor(spy: ReturnType<typeof spyOn>, subcommand: string): string[] | undefined {
  const calls = spy.mock.calls as unknown as unknown[][];
  const call = calls.find((c) => c[0] === 'git' && (c[1] as string[])[0] === subcommand);
  return call?.[1] as string[] | undefined;
}

/** The `git log` invocation `getFilesForRef` builds, for assertion against the spy. */
function logArgs(localSha: string, ...exclusions: string[]): string[] {
  return [
    'log',
    '--format=',
    '--name-only',
    '--diff-filter=ACMR',
    '-c',
    '--root',
    localSha,
    '--not',
    ...exclusions,
  ];
}

describe('gitPreCommit', () => {
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let spawnProcessSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let runSecretsBinarySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fake = new FakeConsole();
    const mocked = mockAuthResolver(FAKE_AUTH);
    runtime = mocked.runtime;
    resolveAuthSpy = mocked.resolveAuthSpy;
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
    await gitPreCommit({}, [], makeCtx());

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
    const [, files] = runSecretsBinarySpy.mock.calls[0] as [string, string[], unknown];
    expect(files).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('throws CommandFailedError when secrets are found', async () => {
    runSecretsBinarySpy.mockResolvedValue(SECRETS_RESULT);

    let thrown: unknown;
    try {
      await gitPreCommit({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect((thrown as CommandFailedError).message).toBe('Secrets detected in staged files.');
  });

  it('prints finding detail (file, line, masked secret) when secrets are found', async () => {
    runSecretsBinarySpy.mockResolvedValue(SECRETS_RESULT_WITH_ISSUES);

    await gitPreCommit({}, [], makeCtx()).catch(() => undefined);

    const prints = fake.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
    expect(prints.some((m) => m.includes('src/config.ts:12'))).toBe(true);
    expect(prints.some((m) => m.includes('AWS key detected'))).toBe(true);
    expect(prints.some((m) => m.includes('AKIA****'))).toBe(true);
  });

  it('resolves without throwing when no secrets are found', async () => {
    await gitPreCommit({}, [], makeCtx());

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
    expect(fake.calls.filter((c) => c.method === 'print')).toHaveLength(0);
    expect(fake.findCall('warn', 'Secrets scan failed')).toBeUndefined();
  });

  it('skips scan when no staged files', async () => {
    spawnProcessSpy.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await gitPreCommit({}, [], makeCtx());

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('throws MissingDependenciesError when auth is unavailable', async () => {
    resolveAuthSpy.mockReturnValue(okAsync(null));

    let thrown: unknown;
    try {
      await gitPreCommit({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MissingDependenciesError);
    expect((thrown as MissingDependenciesError).message).toBe(HOOK_INACTIVE_UNAUTHENTICATED);
    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('throws MissingDependenciesError when binary is not installed', async () => {
    resolveSecretsBinaryPathSpy.mockReturnValue(null);

    let thrown: unknown;
    try {
      await gitPreCommit({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MissingDependenciesError);
    expect((thrown as MissingDependenciesError).message).toBe(SECRETS_INACTIVE_BINARY_MISSING);
    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('throws CommandFailedError when scan throws with env-based auth (CI mode)', async () => {
    runSecretsBinarySpy.mockRejectedValue(new Error('binary crashed'));
    resolveAuthSpy.mockReturnValue(
      okAsync(
        new ResolvedAuth({
          token: 'tok',
          serverUrl: 'https://sonar.example.com',
          connectionType: 'on-premise',
          source: 'env',
        }),
      ),
    );

    let thrown: unknown;
    try {
      await gitPreCommit({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect((thrown as CommandFailedError).message).toBe('Secrets scan failed.');
  });

  it('resolves without throwing when scan fails with keychain auth (fail soft)', async () => {
    runSecretsBinarySpy.mockRejectedValue(new Error('binary crashed'));

    await gitPreCommit({}, [], makeCtx());

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
    expect(
      fake.findCall('warn', 'Commit is not blocked, but secrets were not checked'),
    ).toBeDefined();
    expect(fake.findCall('warn', 'Reason: binary crashed')).toBeDefined();
  });

  it('skips scan when git spawn throws while listing staged files', async () => {
    spawnProcessSpy.mockRejectedValue(new Error('git not found'));

    await gitPreCommit({}, [], makeCtx());

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
    fake = new FakeConsole();
    const mocked = mockAuthResolver(FAKE_AUTH);
    runtime = mocked.runtime;
    resolveAuthSpy = mocked.resolveAuthSpy;
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
    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
    const [, files] = runSecretsBinarySpy.mock.calls[0] as [string, string[], unknown];
    expect(files).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('throws CommandFailedError when secrets are found', async () => {
    runSecretsBinarySpy.mockResolvedValue(SECRETS_RESULT);

    let thrown: unknown;
    try {
      await gitPrePush({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect((thrown as CommandFailedError).message).toBe('Secrets detected in pushed commits.');
  });

  it('prints finding detail (file, line, masked secret) when secrets are found', async () => {
    runSecretsBinarySpy.mockResolvedValue(SECRETS_RESULT_WITH_ISSUES);

    await gitPrePush({}, [], makeCtx()).catch(() => undefined);

    const prints = fake.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
    expect(prints.some((m) => m.includes('src/config.ts:12'))).toBe(true);
    expect(prints.some((m) => m.includes('AWS key detected'))).toBe(true);
    expect(prints.some((m) => m.includes('AKIA****'))).toBe(true);
  });

  it('resolves without throwing when no secrets found', async () => {
    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
    expect(fake.calls.filter((c) => c.method === 'print')).toHaveLength(0);
    expect(fake.findCall('warn', 'Secrets scan failed')).toBeUndefined();
  });

  it('skips scan when refs are empty', async () => {
    readGitPushRefsSpy.mockResolvedValue([]);

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('throws MissingDependenciesError when auth is unavailable', async () => {
    resolveAuthSpy.mockReturnValue(okAsync(null));

    let thrown: unknown;
    try {
      await gitPrePush({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MissingDependenciesError);
    expect((thrown as MissingDependenciesError).message).toBe(SECRETS_INACTIVE_UNAUTHENTICATED);
    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('throws MissingDependenciesError when binary is not installed', async () => {
    resolveSecretsBinaryPathSpy.mockReturnValue(null);

    let thrown: unknown;
    try {
      await gitPrePush({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MissingDependenciesError);
    expect((thrown as MissingDependenciesError).message).toBe(SECRETS_INACTIVE_BINARY_MISSING);
    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('skips ref when localSha is the null OID (branch deletion)', async () => {
    readGitPushRefsSpy.mockResolvedValue([
      { ...FAKE_REF, localSha: '0000000000000000000000000000000000000000' },
    ]);

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('skips ref when no files are returned for it', async () => {
    spawnProcessSpy.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('throws CommandFailedError when scan throws with env-based auth (CI mode)', async () => {
    runSecretsBinarySpy.mockRejectedValue(new Error('binary crashed'));
    resolveAuthSpy.mockReturnValue(
      okAsync(
        new ResolvedAuth({
          token: 'tok',
          serverUrl: 'https://sonar.example.com',
          connectionType: 'on-premise',
          source: 'env',
        }),
      ),
    );

    let thrown: unknown;
    try {
      await gitPrePush({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect((thrown as CommandFailedError).message).toBe('Secrets scan failed.');
  });

  it('resolves without throwing when scan fails with keychain auth (fail soft)', async () => {
    runSecretsBinarySpy.mockRejectedValue(new Error('binary crashed'));

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
    expect(
      fake.findCall('warn', 'Push is not blocked, but secrets were not checked'),
    ).toBeDefined();
    expect(fake.findCall('warn', 'Reason: binary crashed')).toBeDefined();
  });

  it('calls the secrets binary once per ref group', async () => {
    const secondRef = { ...FAKE_REF, localSha: 'def456' };
    readGitPushRefsSpy.mockResolvedValue([FAKE_REF, secondRef]);

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(2);
    for (const call of runSecretsBinarySpy.mock.calls) {
      const [, files] = call as [string, string[], unknown];
      expect(files).toEqual(['src/foo.ts', 'src/bar.ts']);
    }
  });

  it('does not fall back to a full scan when no commits are new to the remote', async () => {
    spawnProcessSpy.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
    // One git call only: any extra would mean a fallback crept back in.
    expect(spawnProcessSpy).toHaveBeenCalledTimes(1);
  });

  it('scans the range between the remote tip and the pushed tip for an existing-branch push', async () => {
    readGitPushRefsSpy.mockResolvedValue([EXISTING_BRANCH_REF]);

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinarySpy).toHaveBeenCalledTimes(1);
    const [, files] = runSecretsBinarySpy.mock.calls[0] as [string, string[], unknown];
    expect(files).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  it('excludes the remote tip from the range when it exists locally', async () => {
    readGitPushRefsSpy.mockResolvedValue([EXISTING_BRANCH_REF]);

    await gitPrePush({}, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(
      logArgs(EXISTING_BRANCH_REF.localSha, EXISTING_BRANCH_REF.remoteSha, '--remotes'),
    );
  });

  it('omits a remote tip absent from the local object database', async () => {
    readGitPushRefsSpy.mockResolvedValue([EXISTING_BRANCH_REF]);
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // cat-file: unknown commit
      .mockResolvedValue({ exitCode: 0, stdout: 'src/foo.ts', stderr: '' });

    await gitPrePush({}, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(
      logArgs(EXISTING_BRANCH_REF.localSha, '--remotes'),
    );
  });

  it('does not probe the object database when the remote ref does not exist yet', async () => {
    await gitPrePush({}, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'cat-file')).toBeUndefined();
  });

  it('skips scan when the file listing fails during an existing-branch push', async () => {
    readGitPushRefsSpy.mockResolvedValue([EXISTING_BRANCH_REF]);
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'deadbeef', stderr: '' }) // cat-file
      .mockRejectedValueOnce(new Error('git log failed'));

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('skips a deletion ref whose null OID is SHA-256 width', async () => {
    readGitPushRefsSpy.mockResolvedValue([{ ...FAKE_REF, localSha: '0'.repeat(64) }]);

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinarySpy).not.toHaveBeenCalled();
  });

  it('scopes the exclusion to the remote when it is one of the configured remotes', async () => {
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'origin\nupstream', stderr: '' }) // git remote
      .mockResolvedValue({ exitCode: 0, stdout: 'src/foo.ts', stderr: '' });

    await gitPrePush({ remoteName: 'origin' }, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(
      logArgs(FAKE_REF.localSha, '--remotes=origin'),
    );
  });

  it('falls back to every remote when the push target is a URL rather than a remote name', async () => {
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'origin', stderr: '' }) // git remote
      .mockResolvedValue({ exitCode: 0, stdout: 'src/foo.ts', stderr: '' });

    await gitPrePush({ remoteName: 'https://host/repo.git' }, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(logArgs(FAKE_REF.localSha, '--remotes'));
  });

  it('falls back to every remote when no remote name is forwarded', async () => {
    await gitPrePush({}, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(logArgs(FAKE_REF.localSha, '--remotes'));
    // No remote name means no need to ask git which remotes exist.
    expect(gitArgsFor(spawnProcessSpy, 'remote')).toBeUndefined();
  });

  it('ignores a blank remote name from a manually invoked hook', async () => {
    await gitPrePush({ remoteName: '  ' }, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(logArgs(FAKE_REF.localSha, '--remotes'));
  });

  it('reads the remote name from the environment when no flag is passed', async () => {
    process.env[REMOTE_NAME_ENV] = 'origin';
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'origin', stderr: '' }) // git remote
      .mockResolvedValue({ exitCode: 0, stdout: 'src/foo.ts', stderr: '' });

    try {
      await gitPrePush({}, [], makeCtx());
    } finally {
      delete process.env[REMOTE_NAME_ENV];
    }

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(
      logArgs(FAKE_REF.localSha, '--remotes=origin'),
    );
  });
});
