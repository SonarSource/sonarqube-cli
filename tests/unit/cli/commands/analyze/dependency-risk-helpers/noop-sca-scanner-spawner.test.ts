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

import { type ScaScannerInstaller } from '../../../../../../src/cli/commands/_common/install/sca-scanner.ts';
import { NoopScaScannerSpawner } from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/noop-sca-scanner-spawner.ts';
import {
  type ScaScannerInvocation,
  ScaScannerRunner,
} from '../../../../../../src/cli/commands/analyze/dependency-risk-helpers/sca-scanner.ts';

const okInstaller: ScaScannerInstaller = { install: () => Promise.resolve('/x') };

function makeInvocation(): ScaScannerInvocation {
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
  };
}

describe('NoopScaScannerSpawner', () => {
  it('resolves to an exit-0 SpawnResult whose stdout parses to an empty AnalyzeProjectResponse', async () => {
    const result = await new NoopScaScannerSpawner().spawn();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ releases: [], parsedFiles: [], errors: [] });
  });

  it('drives ScaScannerRunner end-to-end to an empty AnalyzeProjectResponse', async () => {
    const result = await new ScaScannerRunner(okInstaller, new NoopScaScannerSpawner()).run(
      makeInvocation(),
    );

    expect(result).toEqual({ releases: [], parsedFiles: [], errors: [] });
  });
});
