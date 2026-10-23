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

import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  assertInsideProjectRoot,
  assertInsideProjectRoots,
} from '@/commands/analyze/sqaa-paths.ts';
import { InvalidOptionError } from '@/core/commands/command-error.ts';

describe('assertInsideProjectRoot', () => {
  const repoRoot = join('/', 'repo');
  const projectRoot = join(repoRoot, 'pkg');

  it('accepts paths inside the project root', () => {
    expect(() =>
      assertInsideProjectRoot(
        [join(projectRoot, 'a.ts'), join(projectRoot, 'src', 'b.ts')],
        projectRoot,
        repoRoot,
      ),
    ).not.toThrow();
  });

  it('names the single outside path', () => {
    expect(() =>
      assertInsideProjectRoot(
        [join(projectRoot, 'a.ts'), join(repoRoot, 'other.ts')],
        projectRoot,
        repoRoot,
      ),
    ).toThrow(
      new InvalidOptionError(`File must be inside the project root '${projectRoot}': other.ts`),
    );
  });

  it('lists every outside path in one error', () => {
    expect(() =>
      assertInsideProjectRoot(
        [join(repoRoot, 'x.ts'), join(projectRoot, 'a.ts'), join(repoRoot, 'lib', 'y.ts')],
        projectRoot,
        repoRoot,
      ),
    ).toThrow(
      new InvalidOptionError(
        `Files must be inside the project root '${projectRoot}':\n  x.ts\n  lib/y.ts`,
      ),
    );
  });
});

describe('assertInsideProjectRoots', () => {
  const repoRoot = join('/', 'repo');
  const rootA = join(repoRoot, 'packages', 'a');
  const rootB = join(repoRoot, 'packages', 'b');

  it('accepts an empty list of unmapped files', () => {
    expect(() => assertInsideProjectRoots([], [rootA, rootB], repoRoot)).not.toThrow();
  });

  it('keeps the single-root message when there is one root', () => {
    expect(() => assertInsideProjectRoots([join(repoRoot, 'x.ts')], [rootA], repoRoot)).toThrow(
      new InvalidOptionError(`File must be inside the project root '${rootA}': x.ts`),
    );
  });

  it('names every root and every file when there are several roots', () => {
    expect(() =>
      assertInsideProjectRoots(
        [join(repoRoot, 'x.ts'), join(repoRoot, 'docs', 'y.md')],
        [rootA, rootB],
        repoRoot,
      ),
    ).toThrow(
      new InvalidOptionError(
        `Files must be inside one of the project roots (${rootA}, ${rootB}):\n  x.ts\n  docs/y.md`,
      ),
    );
  });
});
