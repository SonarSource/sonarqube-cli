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
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, mock, spyOn } from 'bun:test';

import { CommandFailedError } from '@/core/command-error.ts';
import type { SpawnResult } from '@/core/process/process.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';

import type { ScaScannerInstaller } from '../../../../../src/commands/_common/install/sca-scanner.ts';
import { ScaDiscoverManifestsRunner } from '../../../../../src/commands/analyze/dependency-risk-helpers/sca-discover-manifests.ts';
import type { ScaScannerInvocation } from '../../../../../src/commands/analyze/dependency-risk-helpers/sca-scanner-runner-base.ts';
import type { ScaScannerSpawner } from '../../../../../src/commands/analyze/dependency-risk-helpers/sca-scanner-spawner.ts';
import { makeScaInvocation as makeInvocation, okScaInstaller as okInstaller } from './_helpers.ts';

function spawnerReturning(result: SpawnResult): ScaScannerSpawner {
  return { spawn: () => Promise.resolve(result) };
}

function discoverManifestsArgs(invocation: ScaScannerInvocation): string[] {
  const spawner = spawnerReturning({ exitCode: 0, stdout: '', stderr: '' });
  return new ScaDiscoverManifestsRunner(okInstaller, spawner).buildArgs(invocation);
}

describe('ScaDiscoverManifestsRunner.run', () => {
  it('parses the files array and drops non-string entries', async () => {
    const stdout = JSON.stringify({
      files: ['package-lock.json', 42, null, 'pom.xml', { nested: true }],
    });
    const runner = new ScaDiscoverManifestsRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout, stderr: '' }),
    );

    const files = await runner.run(makeInvocation());

    expect(files).toEqual(['package-lock.json', 'pom.xml']);
  });

  it('returns an empty list when no manifests are discovered', async () => {
    const runner = new ScaDiscoverManifestsRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout: JSON.stringify({ files: [] }), stderr: '' }),
    );

    expect(await runner.run(makeInvocation())).toEqual([]);
  });

  it('throws CommandFailedError on a non-zero exit code', () => {
    const runner = new ScaDiscoverManifestsRunner(
      okInstaller,
      spawnerReturning({ exitCode: 1, stdout: '', stderr: 'error' }),
    );

    expect(runner.run(makeInvocation())).rejects.toThrow(
      /Manifest discovery error: sca-scanner exited with code 1\./,
    );
  });

  it('throws CommandFailedError when files is not an array', async () => {
    const runner = new ScaDiscoverManifestsRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout: JSON.stringify({ files: 'string' }), stderr: '' }),
    );

    let caught: unknown;
    try {
      await runner.run(makeInvocation());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CommandFailedError);
    expect((caught as CommandFailedError).message).toMatch(/unexpected output/);
  });

  it('throws CommandFailedError when stdout is not valid JSON', async () => {
    const runner = new ScaDiscoverManifestsRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout: 'not json', stderr: '' }),
    );

    let caught: unknown;
    try {
      await runner.run(makeInvocation());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CommandFailedError);
    expect((caught as CommandFailedError).message).toMatch(/failed to parse output/);
    expect((caught as CommandFailedError).remediationHint).toMatch(
      /^Inspect .* for the raw sca-scanner output, then retry\.$/,
    );
  });

  it('throws CommandFailedError when the spawn fails', async () => {
    const runner = new ScaDiscoverManifestsRunner(okInstaller, {
      spawn: () => Promise.reject(new Error('spawn ENOENT')),
    });

    let caught: unknown;
    try {
      await runner.run(makeInvocation());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CommandFailedError);
    expect((caught as CommandFailedError).message).toMatch(
      /Manifest discovery error: spawn ENOENT/,
    );
    expect((caught as CommandFailedError).remediationHint).toBe(
      'Verify that the SCA scanner is installed and can run on this machine, then retry.',
    );
  });

  it('forwards the installer-resolved binary path and discover-manifests args to the spawner', async () => {
    const installer: ScaScannerInstaller = {
      install: () => Promise.resolve('/bin/sca-from-installer'),
    };
    const spawn = mock((_binaryPath: string, _args: string[], _env?: Record<string, string>) =>
      Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ files: [] }), stderr: '' }),
    );
    const invocation = makeInvocation({
      excludedPaths: ['**/dist/**'],
      scannerProperties: { 'sonar.sca.foo': 'bar' },
    });

    await new ScaDiscoverManifestsRunner(installer, { spawn }).run(invocation);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      '/bin/sca-from-installer',
      discoverManifestsArgs(invocation),
      expect.objectContaining({ SONAR_TOKEN: invocation.sonarToken }),
    );
  });

  it('removes the work dir after a successful run', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'sca-discover-ok-'));
    const runner = new ScaDiscoverManifestsRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout: JSON.stringify({ files: [] }), stderr: '' }),
    );

    await runner.run(makeInvocation({ workDir }));

    expect(existsSync(workDir)).toBe(false);
  });

  it('removes the work dir even when discovery fails', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'sca-discover-fail-'));
    const runner = new ScaDiscoverManifestsRunner(
      okInstaller,
      spawnerReturning({ exitCode: 1, stdout: '', stderr: 'error' }),
    );

    let caught: unknown;
    try {
      await runner.run(makeInvocation({ workDir }));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CommandFailedError);
    expect(existsSync(workDir)).toBe(false);
  });

  it('warns but does not fail the run when work dir cleanup throws', async () => {
    const rmSpy = spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked');
    });
    setMockUi(true);
    clearMockUiCalls();
    const runner = new ScaDiscoverManifestsRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout: JSON.stringify({ files: [] }), stderr: '' }),
    );

    try {
      const files = await runner.run(makeInvocation({ workDir: join(tmpdir(), 'sca-cleanup') }));

      expect(files).toEqual([]);
      const warned = getMockUiCalls().some(
        (call) =>
          call.method === 'warn' &&
          String(call.args[0]).includes('Failed to clean up SCA scanner working directory'),
      );
      expect(warned).toBe(true);
    } finally {
      rmSpy.mockRestore();
      setMockUi(false);
    }
  });
});

describe('ScaDiscoverManifestsRunner.buildArgs', () => {
  it('emits the fixed args in declared order without --project-key', () => {
    expect(discoverManifestsArgs(makeInvocation({ workDir: '/work' }))).toEqual([
      'discover-manifests',
      '--base-dir=/repo',
      '--api-base-url=https://api.sonarcloud.io',
      '--download-base-url=https://download.sonarcloud.io/tidelift-cli',
      '--cache-dir=/cache',
      '--work-dir=/work',
    ]);
  });

  it('never emits --project-key even when a project key is set', () => {
    const args = discoverManifestsArgs(makeInvocation({ projectKey: 'my-project' }));
    expect(args.some((a) => a.startsWith('--project-key'))).toBe(false);
  });

  it('forwards scanner properties, exclusions, and flags like analyze-project', () => {
    const args = discoverManifestsArgs(
      makeInvocation({
        scannerProperties: { 'sonar.sca.foo': 'bar' },
        excludedPaths: ['**/dist/**'],
        includeGitIgnoredPaths: true,
        debug: true,
      }),
    );

    expect(args).toContain('--scanner-property=sonar.sca.foo=bar');
    expect(args).toContain('--excluded-path=**/dist/**');
    expect(args).toContain('--include-gitignored-paths');
    expect(args).toContain('--debug');
  });
});
