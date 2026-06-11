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

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, mock } from 'bun:test';

import { CommandFailedError } from '../../../../../../src/cli/commands/_common/error.ts';
import type { ScaScannerInstaller } from '../../../../../../src/cli/commands/_common/install/sca-scanner.ts';
import { ScaDiscoverManifestsRunner } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-discover-manifests.ts';
import { buildDiscoverManifestsArgs } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner-args.ts';
import type { ScaScannerSpawner } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner-spawner.ts';
import type { SpawnResult } from '../../../../../../src/lib/process.ts';
import { makeScaInvocation as makeInvocation, okScaInstaller as okInstaller } from './_helpers.ts';

function spawnerReturning(result: SpawnResult): ScaScannerSpawner {
  return { spawn: () => Promise.resolve(result) };
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
      /Manifest discovery failed \(exit code 1\)/,
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

  it('throws CommandFailedError when stdout is not valid JSON', () => {
    const runner = new ScaDiscoverManifestsRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout: 'not json', stderr: '' }),
    );

    expect(runner.run(makeInvocation())).rejects.toThrow();
  });

  it('forwards the installer-resolved binary path and discover-manifests args to the spawner', async () => {
    const installer: ScaScannerInstaller = {
      install: () => Promise.resolve('/bin/sca-from-installer'),
    };
    const spawn = mock((_binaryPath: string, _args: string[]) =>
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
      buildDiscoverManifestsArgs(invocation),
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
});
