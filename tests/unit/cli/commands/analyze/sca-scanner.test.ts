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

import { describe, expect, it } from 'bun:test';

import { ScaScannerInstallerLike } from '../../../../../src/cli/commands/_common/install/sca-scanner.ts';
import {
  ScaScannerInvocation,
  ScaScannerRunner,
} from '../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';
import { ScaScannerSpawnerLike } from '../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner-spawner.ts';
import type { SpawnResult } from '../../../../../src/lib/process.ts';

const okInstaller: ScaScannerInstallerLike = { install: () => Promise.resolve('/bin/sca') };
const noopSpawner: ScaScannerSpawnerLike = {
  spawn: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
};

function spawnerReturning(result: SpawnResult): ScaScannerSpawnerLike {
  return { spawn: () => Promise.resolve(result) };
}

function spawnerThrowing(err: Error): ScaScannerSpawnerLike {
  return { spawn: () => Promise.reject(err) };
}

function makeInvocation(overrides: Partial<ScaScannerInvocation> = {}): ScaScannerInvocation {
  return {
    baseDir: '/repo',
    apiBaseUrl: 'https://api.sonarcloud.io',
    downloadBaseUrl: 'https://download.sonarcloud.io/tidelift-cli',
    sonarToken: 'tok',
    projectKey: 'my-project',
    cacheDir: '/cache',
    workDir: '/work',
    scannerProperties: {},
    excludedPaths: [],
    includeGitIgnoredPaths: false,
    debug: false,
    ...overrides,
  };
}

describe('ScaScannerRunner.buildArgs', () => {
  it('emits the fixed args in declared order', () => {
    const args = new ScaScannerRunner(okInstaller, noopSpawner).buildArgs(makeInvocation());

    expect(args).toEqual([
      'analyze-project',
      '--base-dir=/repo',
      '--api-base-url=https://api.sonarcloud.io',
      '--download-base-url=https://download.sonarcloud.io/tidelift-cli',
      '--sonar-token=tok',
      '--project-key=my-project',
      '--cache-dir=/cache',
      '--work-dir=/work',
    ]);
  });

  it('repeats --scanner-property=name=value for each entry', () => {
    const args = new ScaScannerRunner(okInstaller, noopSpawner).buildArgs(
      makeInvocation({
        scannerProperties: { 'sonar.sca.foo': 'bar', 'sonar.sca.baz': '1,2' },
      }),
    );

    const pairs = args.filter((a) => a.startsWith('--scanner-property='));
    expect(pairs).toEqual([
      '--scanner-property=sonar.sca.foo=bar',
      '--scanner-property=sonar.sca.baz=1,2',
    ]);
  });

  it('repeats --excluded-path for each exclusion in input order', () => {
    const args = new ScaScannerRunner(okInstaller, noopSpawner).buildArgs(
      makeInvocation({ excludedPaths: ['**/test/**', '**/dist/**'] }),
    );

    const excluded = args.filter((a) => a.startsWith('--excluded-path='));
    expect(excluded).toEqual(['--excluded-path=**/test/**', '--excluded-path=**/dist/**']);
  });

  it('emits --include-gitignored-paths only when the flag is true', () => {
    expect(
      new ScaScannerRunner(okInstaller, noopSpawner).buildArgs(
        makeInvocation({ includeGitIgnoredPaths: false }),
      ),
    ).not.toContain('--include-gitignored-paths');
    expect(
      new ScaScannerRunner(okInstaller, noopSpawner).buildArgs(
        makeInvocation({ includeGitIgnoredPaths: true }),
      ),
    ).toContain('--include-gitignored-paths');
  });

  it('emits --debug only when the flag is true', () => {
    expect(
      new ScaScannerRunner(okInstaller, noopSpawner).buildArgs(makeInvocation({ debug: false })),
    ).not.toContain('--debug');
    expect(
      new ScaScannerRunner(okInstaller, noopSpawner).buildArgs(makeInvocation({ debug: true })),
    ).toContain('--debug');
  });
});

describe('ScaScannerRunner.run', () => {
  it('propagates the installer error when install fails', () => {
    const failingInstaller: ScaScannerInstallerLike = {
      install: () => Promise.reject(new Error('not installed')),
    };
    expect(
      new ScaScannerRunner(failingInstaller, noopSpawner).run(makeInvocation()),
    ).rejects.toThrow(/not installed/);
  });

  it('returns the parsed result on exit 0 with valid JSON', async () => {
    const stdout = JSON.stringify({
      packages: [
        {
          purl: 'pkg:npm/lodash@4.17.21',
          dependencyFilePaths: ['package-lock.json'],
          dependencyChains: [['pkg:npm/lodash@4.17.21']],
          license: { expression: 'MIT', allowed: true },
          vulnerabilities: [],
          malicious: false,
          knownPackage: true,
          knownRelease: true,
        },
      ],
      parsedFiles: ['package-lock.json'],
      errors: [],
    });
    const runner = new ScaScannerRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout, stderr: '' }),
    );
    const result = await runner.run(makeInvocation());
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0].purl).toBe('pkg:npm/lodash@4.17.21');
    expect(result.packages[0].license).toEqual({ expression: 'MIT', allowed: true });
    expect(result.packages[0].dependencyFilePaths).toEqual(['package-lock.json']);
    expect(result.packages[0].dependencyChains).toEqual([['pkg:npm/lodash@4.17.21']]);
    expect(result.parsedFiles).toEqual(['package-lock.json']);
    expect(result.errors).toEqual([]);
  });

  it('throws CommandFailedError on exit 0 with non-JSON stdout', () => {
    const runner = new ScaScannerRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout: 'not json', stderr: '' }),
    );
    expect(runner.run(makeInvocation())).rejects.toThrow(/failed to parse output/);
  });

  it("throws CommandFailedError when 'packages' field is missing", () => {
    const runner = new ScaScannerRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout: '{}', stderr: '' }),
    );
    expect(runner.run(makeInvocation())).rejects.toThrow(/missing 'packages' array/);
  });

  it("throws CommandFailedError when 'packages' is not an array", () => {
    const runner = new ScaScannerRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout: '{"packages":"oops"}', stderr: '' }),
    );
    expect(runner.run(makeInvocation())).rejects.toThrow(/missing 'packages' array/);
  });

  it("throws CommandFailedError when 'parsedFiles' is missing", () => {
    const runner = new ScaScannerRunner(
      okInstaller,
      spawnerReturning({ exitCode: 0, stdout: '{"packages":[],"errors":[]}', stderr: '' }),
    );
    expect(runner.run(makeInvocation())).rejects.toThrow(/missing 'parsedFiles' array/);
  });

  it("throws CommandFailedError when 'errors' is not an array", () => {
    const runner = new ScaScannerRunner(
      okInstaller,
      spawnerReturning({
        exitCode: 0,
        stdout: '{"packages":[],"parsedFiles":[],"errors":"oops"}',
        stderr: '',
      }),
    );
    expect(runner.run(makeInvocation())).rejects.toThrow(/missing 'errors' array/);
  });

  it('throws CommandFailedError on non-zero exit including stderr text', () => {
    const runner = new ScaScannerRunner(
      okInstaller,
      spawnerReturning({ exitCode: 2, stdout: '', stderr: 'boom' }),
    );
    expect(runner.run(makeInvocation())).rejects.toThrow(
      /sca-scanner exited with code 2[\s\S]*boom/,
    );
  });

  it('wraps a spawner rejection into CommandFailedError', () => {
    const runner = new ScaScannerRunner(okInstaller, spawnerThrowing(new Error('spawn EACCES')));
    expect(runner.run(makeInvocation())).rejects.toThrow(
      /Dependency collection error: spawn EACCES/,
    );
  });
});
