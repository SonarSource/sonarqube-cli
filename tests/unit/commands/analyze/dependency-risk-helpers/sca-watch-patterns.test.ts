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

import type { ScaScannerInstaller } from '../../../../../src/commands/_common/install/sca-scanner.ts';
import type { ScaScannerSpawner } from '../../../../../src/commands/analyze/dependency-risk-helpers/sca-scanner-spawner.ts';
import {
  anyFileMatches,
  ScaWatchPatternsRunner,
} from '../../../../../src/commands/analyze/dependency-risk-helpers/sca-watch-patterns.ts';

const okInstaller: ScaScannerInstaller = { install: () => Promise.resolve('/bin/sca') };

function spawnerReturning(exitCode: number, stdout: string): ScaScannerSpawner {
  return { spawn: () => Promise.resolve({ exitCode, stdout, stderr: '' }) };
}

function watchPatternsPayload(patterns: unknown): string {
  return JSON.stringify({ patterns });
}

describe('ScaWatchPatternsRunner', () => {
  it('returns parsed patterns from a valid response', async () => {
    const runner = new ScaWatchPatternsRunner(
      okInstaller,
      spawnerReturning(0, watchPatternsPayload(['package.json', '*.csproj'])),
    );
    expect(await runner.run()).toEqual(['package.json', '*.csproj']);
  });

  it('returns [] on non-zero exit', async () => {
    const runner = new ScaWatchPatternsRunner(okInstaller, spawnerReturning(1, ''));
    expect(await runner.run()).toEqual([]);
  });

  it('returns [] when stdout contains no JSON', async () => {
    const runner = new ScaWatchPatternsRunner(okInstaller, spawnerReturning(0, 'no json here'));
    expect(await runner.run()).toEqual([]);
  });

  it('returns [] when patterns is not an array', async () => {
    const runner = new ScaWatchPatternsRunner(
      okInstaller,
      spawnerReturning(0, watchPatternsPayload('not-an-array')),
    );
    expect(await runner.run()).toEqual([]);
  });

  it('returns [] when the spawner throws', async () => {
    const throwing: ScaScannerSpawner = {
      spawn: () => Promise.reject(new Error('spawn failed')),
    };
    const runner = new ScaWatchPatternsRunner(okInstaller, throwing);
    expect(await runner.run()).toEqual([]);
  });
});

describe('anyFileMatches', () => {
  it('returns false for empty inputs', () => {
    expect(anyFileMatches([], ['package.json'])).toBe(false);
    expect(anyFileMatches(['package.json'], [])).toBe(false);
  });

  it('matches bare filenames against any path', () => {
    expect(anyFileMatches(['frontend/package.json'], ['package.json'])).toBe(true);
    expect(anyFileMatches(['package.json'], ['package.json'])).toBe(true);
  });

  it('matches *.ext patterns', () => {
    expect(anyFileMatches(['App.csproj'], ['*.csproj'])).toBe(true);
    expect(anyFileMatches(['src/App.csproj'], ['*.csproj'])).toBe(true);
    expect(anyFileMatches(['App.txt'], ['*.csproj'])).toBe(false);
  });

  it('matches path-style **/ globs', () => {
    expect(anyFileMatches(['obj/project.assets.json'], ['**/obj/project.assets.json'])).toBe(true);
    expect(anyFileMatches(['a/b/obj/project.assets.json'], ['**/obj/project.assets.json'])).toBe(
      true,
    );
    expect(anyFileMatches(['project.assets.json'], ['**/obj/project.assets.json'])).toBe(false);
  });

  it('matches bare filename patterns against files in subdirectories', () => {
    expect(anyFileMatches(['frontend/package.json'], ['package.json'])).toBe(true);
    expect(anyFileMatches(['a/b/c/package.json'], ['package.json'])).toBe(true);
    expect(anyFileMatches(['src/App.csproj'], ['*.csproj'])).toBe(true);
  });

  it('matches dotfiles and files inside hidden directories', () => {
    expect(anyFileMatches(['.package-lock.json'], ['*.json'])).toBe(true);
    expect(anyFileMatches(['src/.hidden/package.json'], ['package.json'])).toBe(true);
  });

  it('matches path-prefix patterns like requirements/*.txt', () => {
    expect(anyFileMatches(['requirements/dev.txt'], ['requirements/*.txt'])).toBe(true);
    expect(anyFileMatches(['requirements/sub/dev.txt'], ['requirements/*.txt'])).toBe(false);
  });

  it('expands {xml,json} brace lists', () => {
    expect(anyFileMatches(['cyclonedx.xml'], ['cyclonedx.{xml,json}'])).toBe(true);
    expect(anyFileMatches(['cyclonedx.json'], ['cyclonedx.{xml,json}'])).toBe(true);
    expect(anyFileMatches(['cyclonedx.yaml'], ['cyclonedx.{xml,json}'])).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('matches case-insensitively on Windows', () => {
    expect(anyFileMatches(['Frontend\\Package.json'], ['package.json'])).toBe(true);
  });

  it('matches prefix-with-star like req*.txt', () => {
    expect(anyFileMatches(['requirements.txt'], ['req*.txt'])).toBe(true);
    expect(anyFileMatches(['req-dev.txt'], ['req*.txt'])).toBe(true);
    expect(anyFileMatches(['notrequirements.txt'], ['req*.txt'])).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')(
    'matches Windows backslash paths against bare filename patterns',
    () => {
      expect(anyFileMatches(['frontend\\package.json'], ['package.json'])).toBe(true);
      expect(anyFileMatches(['a\\b\\c\\package.json'], ['package.json'])).toBe(true);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'matches Windows backslash paths against path-style globs',
    () => {
      expect(anyFileMatches(['obj\\project.assets.json'], ['**/obj/project.assets.json'])).toBe(
        true,
      );
      expect(anyFileMatches(['requirements\\dev.txt'], ['requirements/*.txt'])).toBe(true);
    },
  );
});
