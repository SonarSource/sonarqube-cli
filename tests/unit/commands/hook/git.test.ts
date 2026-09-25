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

/** The `git log` invocation `getPushedCommitBlobs` builds, for assertion against the spy. */
function logArgs(localShas: string[], ...exclusions: string[]): string[] {
  return [
    'log',
    '--format=%H',
    '--raw',
    '--no-abbrev',
    '--diff-filter=ACMR',
    '-c',
    '--root',
    ...localShas,
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
  let catFileSpy: ReturnType<typeof spyOn>;
  let resolveSecretsBinaryPathSpy: ReturnType<typeof spyOn>;
  let runSecretsBinaryOnBatchSpy: ReturnType<typeof spyOn>;
  let readGitPushRefsSpy: ReturnType<typeof spyOn>;

  const COMMIT_A = 'a'.repeat(40);
  const COMMIT_B = 'b'.repeat(40);
  const BLOB_A = '1'.repeat(40);
  const BLOB_B = '2'.repeat(40);

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

  interface FakeCommit {
    commit: string;
    blobs: Array<{
      oid: string;
      path: string;
      mode?: string;
      status?: string;
      sourcePath?: string;
    }>;
  }

  /** `git log --format=%H --raw --no-abbrev` output: a commit line, then one change line per blob. */
  function logOutput(...commits: FakeCommit[]): string {
    return commits
      .flatMap(({ commit, blobs }) => [
        commit,
        ...blobs.map((blob) => {
          const paths = blob.sourcePath ? `${blob.sourcePath}\t${blob.path}` : blob.path;
          return `:000000 ${blob.mode ?? '100644'} ${'0'.repeat(40)} ${blob.oid} ${blob.status ?? 'A'}\t${paths}`;
        }),
      ])
      .join('\n');
  }

  /** One change line of a merge's combined diff: a mode and an object name per parent, then the destination's. */
  function combinedRawLine(mode: string, oid: string, path: string): string {
    const zero = '0'.repeat(40);
    return `::${mode} ${mode} ${mode} ${zero} ${zero} ${oid} MM\t${path}`;
  }

  /** `git cat-file --batch` output for the given contents, in request order. */
  function catFileOutput(...contents: string[]): Buffer {
    return Buffer.concat(
      contents.map((content) =>
        Buffer.from(`${BLOB_A} blob ${Buffer.byteLength(content)}\n${content}\n`),
      ),
    );
  }

  /** The encoded batch handed to the analyzer for the nth scan. */
  function batchOf(index: number): string {
    const [, batch] = runSecretsBinaryOnBatchSpy.mock.calls[index] as [string, Buffer, unknown];
    return batch.toString('utf-8');
  }

  const ONE_COMMIT = logOutput({ commit: COMMIT_A, blobs: [{ oid: BLOB_A, path: 'src/foo.ts' }] });

  beforeEach(() => {
    fake = new FakeConsole();
    const mocked = mockAuthResolver(FAKE_AUTH);
    runtime = mocked.runtime;
    resolveAuthSpy = mocked.resolveAuthSpy;
    spawnProcessSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
      exitCode: 0,
      stdout: ONE_COMMIT,
      stderr: '',
    });
    catFileSpy = spyOn(processLib, 'spawnProcessCapturingBytes').mockResolvedValue({
      exitCode: 0,
      stdout: catFileOutput('const a = 1;'),
      stderr: '',
    });
    resolveSecretsBinaryPathSpy = spyOn(installSecrets, 'resolveSecretsBinaryPath').mockReturnValue(
      '/usr/bin/sonar-secrets',
    );
    runSecretsBinaryOnBatchSpy = spyOn(analyzeSecrets, 'runSecretsBinaryOnBatch').mockResolvedValue(
      OK_RESULT,
    );
    readGitPushRefsSpy = spyOn(stdinModule, 'readGitPushRefs').mockResolvedValue([FAKE_REF]);
  });

  afterEach(() => {
    resolveAuthSpy.mockRestore();
    spawnProcessSpy.mockRestore();
    catFileSpy.mockRestore();
    resolveSecretsBinaryPathSpy.mockRestore();
    runSecretsBinaryOnBatchSpy.mockRestore();
    readGitPushRefsSpy.mockRestore();
  });

  it('scans the blobs the push would transfer, keyed by their paths', async () => {
    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).toHaveBeenCalledTimes(1);
    expect(batchOf(0)).toBe('12 src/foo.ts\nconst a = 1;\n');
  });

  it('reads blob content out of git rather than the working tree', async () => {
    await gitPrePush({}, [], makeCtx());

    const [command, args] = catFileSpy.mock.calls[0] as [string, string[], { stdinData: string }];
    expect(command).toBe('git');
    expect(args).toEqual(['cat-file', '--batch']);
    const [, , options] = catFileSpy.mock.calls[0] as [string, string[], { stdinData: string }];
    expect(options.stdinData).toBe(`${BLOB_A}\n`);
  });

  it('throws CommandFailedError naming the offending commit when secrets are found', async () => {
    runSecretsBinaryOnBatchSpy.mockResolvedValue(SECRETS_RESULT);

    let thrown: unknown;
    try {
      await gitPrePush({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect((thrown as CommandFailedError).message).toBe('Secrets detected in aaaaaaaa.');
  });

  it('prints the commit alongside the finding detail when secrets are found', async () => {
    runSecretsBinaryOnBatchSpy.mockResolvedValue(SECRETS_RESULT_WITH_ISSUES);

    await gitPrePush({}, [], makeCtx()).catch(() => undefined);

    const prints = fake.calls.filter((c) => c.method === 'print').map((c) => String(c.args[0]));
    expect(prints.some((m) => m.includes(`commit ${COMMIT_A}`))).toBe(true);
    expect(prints.some((m) => m.includes('src/config.ts:12'))).toBe(true);
    expect(prints.some((m) => m.includes('AWS key detected'))).toBe(true);
    expect(prints.some((m) => m.includes('AKIA****'))).toBe(true);
  });

  it('names every offending commit when more than one carries a secret', async () => {
    readGitPushRefsSpy.mockResolvedValue([FAKE_REF]);
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: logOutput(
        { commit: COMMIT_A, blobs: [{ oid: BLOB_A, path: 'a.ts' }] },
        { commit: COMMIT_B, blobs: [{ oid: BLOB_B, path: 'b.ts' }] },
      ),
      stderr: '',
    });
    runSecretsBinaryOnBatchSpy.mockResolvedValue(SECRETS_RESULT);

    let thrown: unknown;
    try {
      await gitPrePush({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    // `git log` walks newest first, so the oldest commit is reported first.
    expect((thrown as CommandFailedError).message).toBe('Secrets detected in bbbbbbbb, aaaaaaaa.');
  });

  it('calls the analyzer once per commit', async () => {
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: logOutput(
        { commit: COMMIT_A, blobs: [{ oid: BLOB_A, path: 'a.ts' }] },
        { commit: COMMIT_B, blobs: [{ oid: BLOB_B, path: 'b.ts' }] },
      ),
      stderr: '',
    });

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).toHaveBeenCalledTimes(2);
    expect(batchOf(0)).toContain('b.ts');
    expect(batchOf(1)).toContain('a.ts');
  });

  it('attributes a blob to the oldest commit carrying it rather than scanning it twice', async () => {
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: logOutput(
        { commit: COMMIT_A, blobs: [{ oid: BLOB_A, path: 'same.ts' }] },
        { commit: COMMIT_B, blobs: [{ oid: BLOB_A, path: 'same.ts' }] },
      ),
      stderr: '',
    });
    runSecretsBinaryOnBatchSpy.mockResolvedValue(SECRETS_RESULT);

    let thrown: unknown;
    try {
      await gitPrePush({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }

    expect(runSecretsBinaryOnBatchSpy).toHaveBeenCalledTimes(1);
    expect(batchOf(0)).toContain('same.ts');
    expect(fake.findCall('print', `commit ${COMMIT_B}`)).toBeDefined();
    expect((thrown as CommandFailedError).message).toBe(
      `Secrets detected in ${COMMIT_B.slice(0, 8)}.`,
    );
  });

  it('refuses the push when blob content cannot be read', async () => {
    catFileSpy.mockResolvedValue({ exitCode: 128, stdout: Buffer.alloc(0), stderr: 'bad object' });

    let thrown: unknown;
    try {
      await gitPrePush({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect((thrown as CommandFailedError).message).toContain('was not scanned');
    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
  });

  it('refuses the push when git returns fewer blobs than requested', async () => {
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: logOutput({
        commit: COMMIT_A,
        blobs: [
          { oid: BLOB_A, path: 'a.ts' },
          { oid: BLOB_B, path: 'b.ts' },
        ],
      }),
      stderr: '',
    });

    let thrown: unknown;
    try {
      await gitPrePush({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CommandFailedError);
    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
  });

  it('skips a path that cannot be expressed in the batch header', async () => {
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: logOutput({ commit: COMMIT_A, blobs: [{ oid: BLOB_A, path: 'odd\rname.ts' }] }),
      stderr: '',
    });

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
  });

  it('unquotes the path git escaped before handing it to the analyzer', async () => {
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: logOutput({
        commit: COMMIT_A,
        blobs: [{ oid: BLOB_A, path: '"src/caf\\303\\251.ts"' }],
      }),
      stderr: '',
    });

    await gitPrePush({}, [], makeCtx());

    expect(batchOf(0)).toBe('12 src/café.ts\nconst a = 1;\n');
  });

  it('scans a path it cannot unquote under the name git printed', async () => {
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: logOutput({ commit: COMMIT_A, blobs: [{ oid: BLOB_A, path: '"src/\\377.ts"' }] }),
      stderr: '',
    });

    await gitPrePush({}, [], makeCtx());

    expect(batchOf(0)).toBe('12 "src/\\377.ts"\nconst a = 1;\n');
  });

  it.each([['"new\\nline.ts"'], ['"carriage\\rreturn.ts"']])(
    'scans %p under the name git printed, since the decoded one breaks the batch header',
    async (quoted) => {
      spawnProcessSpy.mockResolvedValue({
        exitCode: 0,
        stdout: logOutput({ commit: COMMIT_A, blobs: [{ oid: BLOB_A, path: quoted }] }),
        stderr: '',
      });

      await gitPrePush({}, [], makeCtx());

      expect(batchOf(0)).toBe(`12 ${quoted}\nconst a = 1;\n`);
    },
  );

  it('scans a rename under its destination path', async () => {
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: logOutput({
        commit: COMMIT_A,
        blobs: [{ oid: BLOB_A, path: 'src/new.ts', status: 'R100', sourcePath: 'src/old.ts' }],
      }),
      stderr: '',
    });

    await gitPrePush({}, [], makeCtx());

    expect(batchOf(0)).toBe('12 src/new.ts\nconst a = 1;\n');
  });

  it('skips a submodule pointer and scans the rest of the commit', async () => {
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: logOutput({
        commit: COMMIT_A,
        blobs: [
          { oid: BLOB_A, path: 'sub', mode: '160000' },
          { oid: BLOB_B, path: 'src/foo.ts' },
        ],
      }),
      stderr: '',
    });

    await gitPrePush({}, [], makeCtx());

    const [, , options] = catFileSpy.mock.calls[0] as [string, string[], { stdinData: string }];
    expect(options.stdinData).toBe(`${BLOB_B}\n`);
    expect(batchOf(0)).toBe('12 src/foo.ts\nconst a = 1;\n');
  });

  it('skips a submodule pointer in the combined diff of a merge', async () => {
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: [
        COMMIT_A,
        combinedRawLine('160000', BLOB_A, 'sub'),
        combinedRawLine('100644', BLOB_B, 'src/foo.ts'),
      ].join('\n'),
      stderr: '',
    });

    await gitPrePush({}, [], makeCtx());

    const [, , options] = catFileSpy.mock.calls[0] as [string, string[], { stdinData: string }];
    expect(options.stdinData).toBe(`${BLOB_B}\n`);
    expect(batchOf(0)).toBe('12 src/foo.ts\nconst a = 1;\n');
  });

  it('lets a push through when its only change is a submodule pointer', async () => {
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: logOutput({
        commit: COMMIT_A,
        blobs: [{ oid: BLOB_A, path: 'sub', mode: '160000' }],
      }),
      stderr: '',
    });

    await gitPrePush({}, [], makeCtx());

    expect(catFileSpy).not.toHaveBeenCalled();
    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
  });

  it('resolves without throwing when no secrets found', async () => {
    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).toHaveBeenCalledTimes(1);
    expect(fake.calls.filter((c) => c.method === 'print')).toHaveLength(0);
    expect(fake.findCall('warn', 'Secrets scan failed')).toBeUndefined();
  });

  it('skips scan when refs are empty', async () => {
    readGitPushRefsSpy.mockResolvedValue([]);

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
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
    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
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
    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
  });

  it('skips ref when localSha is the null OID (branch deletion)', async () => {
    readGitPushRefsSpy.mockResolvedValue([
      { ...FAKE_REF, localSha: '0000000000000000000000000000000000000000' },
    ]);

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
  });

  it('skips a deletion ref whose null OID is SHA-256 width', async () => {
    readGitPushRefsSpy.mockResolvedValue([{ ...FAKE_REF, localSha: '0'.repeat(64) }]);

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
  });

  it('skips ref when no blobs are returned for it', async () => {
    spawnProcessSpy.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
  });

  it('throws CommandFailedError when scan throws with env-based auth (CI mode)', async () => {
    runSecretsBinaryOnBatchSpy.mockRejectedValue(new Error('binary crashed'));
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
    runSecretsBinaryOnBatchSpy.mockRejectedValue(new Error('binary crashed'));

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).toHaveBeenCalledTimes(1);
    expect(
      fake.findCall('warn', 'Push is not blocked, but secrets were not checked'),
    ).toBeDefined();
    expect(fake.findCall('warn', 'Reason: binary crashed')).toBeDefined();
  });

  it('stops after the first failed scan instead of retrying it for every commit', async () => {
    spawnProcessSpy.mockResolvedValue({
      exitCode: 0,
      stdout: logOutput(
        { commit: COMMIT_A, blobs: [{ oid: BLOB_A, path: 'a.ts' }] },
        { commit: COMMIT_B, blobs: [{ oid: BLOB_B, path: 'b.ts' }] },
      ),
      stderr: '',
    });
    runSecretsBinaryOnBatchSpy.mockRejectedValue(new Error('binary crashed'));

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).toHaveBeenCalledTimes(1);
    const warnings = fake.calls.filter(
      (c) =>
        c.method === 'warn' &&
        typeof c.args[0] === 'string' &&
        c.args[0].includes('secrets were not checked'),
    );
    expect(warnings).toHaveLength(1);
  });

  it('does not fall back to a full scan when no commits are new to the remote', async () => {
    spawnProcessSpy.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
    // One git call only: any extra would mean a fallback crept back in.
    expect(spawnProcessSpy).toHaveBeenCalledTimes(1);
    expect(catFileSpy).not.toHaveBeenCalled();
  });

  it('excludes the remote tip from the range when it exists locally', async () => {
    readGitPushRefsSpy.mockResolvedValue([EXISTING_BRANCH_REF]);

    await gitPrePush({}, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(
      logArgs([EXISTING_BRANCH_REF.localSha], EXISTING_BRANCH_REF.remoteSha, '--remotes'),
    );
  });

  it('excludes the remote tip of every pushed ref', async () => {
    const OTHER_TIP = 'f'.repeat(40);
    readGitPushRefsSpy.mockResolvedValue([
      EXISTING_BRANCH_REF,
      { ...EXISTING_BRANCH_REF, localSha: 'def456', remoteSha: OTHER_TIP },
    ]);

    await gitPrePush({}, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(
      logArgs(
        [EXISTING_BRANCH_REF.localSha, 'def456'],
        EXISTING_BRANCH_REF.remoteSha,
        OTHER_TIP,
        '--remotes',
      ),
    );
  });

  it('walks every pushed ref in a single pass', async () => {
    readGitPushRefsSpy.mockResolvedValue([FAKE_REF, { ...FAKE_REF, localSha: 'def456' }]);

    await gitPrePush({}, [], makeCtx());

    const logCalls = (spawnProcessSpy.mock.calls as unknown as unknown[][]).filter(
      (c) => c[0] === 'git' && (c[1] as string[])[0] === 'log',
    );
    expect(logCalls).toHaveLength(1);
    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(
      logArgs([FAKE_REF.localSha, 'def456'], '--remotes'),
    );
  });

  it('names a commit carried by two pushed refs only once', async () => {
    readGitPushRefsSpy.mockResolvedValue([FAKE_REF, { ...FAKE_REF, localSha: 'def456' }]);
    runSecretsBinaryOnBatchSpy.mockResolvedValue(SECRETS_RESULT);

    let thrown: unknown;
    try {
      await gitPrePush({}, [], makeCtx());
    } catch (e) {
      thrown = e;
    }

    expect(runSecretsBinaryOnBatchSpy).toHaveBeenCalledTimes(1);
    expect((thrown as CommandFailedError).message).toBe(
      `Secrets detected in ${COMMIT_A.slice(0, 8)}.`,
    );
  });

  it('omits a remote tip absent from the local object database', async () => {
    readGitPushRefsSpy.mockResolvedValue([EXISTING_BRANCH_REF]);
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' }) // cat-file: unknown commit
      .mockResolvedValue({ exitCode: 0, stdout: ONE_COMMIT, stderr: '' });

    await gitPrePush({}, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(
      logArgs([EXISTING_BRANCH_REF.localSha], '--remotes'),
    );
  });

  it('does not probe the object database when the remote ref does not exist yet', async () => {
    await gitPrePush({}, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'cat-file')).toBeUndefined();
  });

  it('skips scan when the commit listing fails during an existing-branch push', async () => {
    readGitPushRefsSpy.mockResolvedValue([EXISTING_BRANCH_REF]);
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'deadbeef', stderr: '' }) // cat-file
      .mockRejectedValueOnce(new Error('git log failed'));

    await gitPrePush({}, [], makeCtx());

    expect(runSecretsBinaryOnBatchSpy).not.toHaveBeenCalled();
  });

  it('scopes the exclusion to the remote when it is one of the configured remotes', async () => {
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'origin\nupstream', stderr: '' }) // git remote
      .mockResolvedValue({ exitCode: 0, stdout: ONE_COMMIT, stderr: '' });

    await gitPrePush({ remoteName: 'origin' }, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(
      logArgs([FAKE_REF.localSha], '--remotes=origin'),
    );
  });

  it('falls back to every remote when the push target is a URL rather than a remote name', async () => {
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'origin', stderr: '' }) // git remote
      .mockResolvedValue({ exitCode: 0, stdout: ONE_COMMIT, stderr: '' });

    await gitPrePush({ remoteName: 'https://host/repo.git' }, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(logArgs([FAKE_REF.localSha], '--remotes'));
  });

  it('falls back to every remote when no remote name is forwarded', async () => {
    await gitPrePush({}, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(logArgs([FAKE_REF.localSha], '--remotes'));
    // No remote name means no need to ask git which remotes exist.
    expect(gitArgsFor(spawnProcessSpy, 'remote')).toBeUndefined();
  });

  it('ignores a blank remote name from a manually invoked hook', async () => {
    await gitPrePush({ remoteName: '  ' }, [], makeCtx());

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(logArgs([FAKE_REF.localSha], '--remotes'));
  });

  it('reads the remote name from the environment when no flag is passed', async () => {
    process.env[REMOTE_NAME_ENV] = 'origin';
    spawnProcessSpy
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'origin', stderr: '' }) // git remote
      .mockResolvedValue({ exitCode: 0, stdout: ONE_COMMIT, stderr: '' });

    try {
      await gitPrePush({}, [], makeCtx());
    } finally {
      delete process.env[REMOTE_NAME_ENV];
    }

    expect(gitArgsFor(spawnProcessSpy, 'log')).toEqual(
      logArgs([FAKE_REF.localSha], '--remotes=origin'),
    );
  });
});
