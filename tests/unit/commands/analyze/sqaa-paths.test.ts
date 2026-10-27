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
  assertExplicitFilesAnalyzable,
  assertInsideProjectRoot,
  assertInsideProjectRoots,
  resolveSqaaRunFiles,
  soleFile,
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

describe('assertExplicitFilesAnalyzable', () => {
  const repoRoot = join('/', 'repo');
  const rootA = join(repoRoot, 'packages', 'a');

  it('accepts a run that ignored nothing', () => {
    expect(() => assertExplicitFilesAnalyzable([], [rootA], repoRoot)).not.toThrow();
  });

  it('refuses a file owned by a project of another connection', () => {
    expect(() =>
      assertExplicitFilesAnalyzable(
        [{ path: join(repoRoot, 'packages', 'b', 'x.ts'), reason: 'other-connection' }],
        [rootA],
        repoRoot,
      ),
    ).toThrow(
      new InvalidOptionError(
        'Files belong to a project linked to another server or organization than the active connection:\n  packages/b/x.ts',
      ),
    );
  });

  it('names the roots for a file owned by no project', () => {
    expect(() =>
      assertExplicitFilesAnalyzable(
        [{ path: join(repoRoot, 'x.ts'), reason: 'outside-project' }],
        [rootA],
        repoRoot,
      ),
    ).toThrow(new InvalidOptionError(`File must be inside the project root '${rootA}': x.ts`));
  });

  it('reports the other-connection file first when both kinds are present', () => {
    expect(() =>
      assertExplicitFilesAnalyzable(
        [
          { path: join(repoRoot, 'x.ts'), reason: 'outside-project' },
          { path: join(repoRoot, 'packages', 'b', 'y.ts'), reason: 'other-connection' },
        ],
        [rootA],
        repoRoot,
      ),
    ).toThrow(/another server or organization/);
  });

  it('does not treat binary or oversized ignores as an input error', () => {
    expect(() =>
      assertExplicitFilesAnalyzable([{ path: 'x.png', reason: 'binary' }], [rootA], repoRoot),
    ).not.toThrow();
  });
});

describe('resolveSqaaRunFiles', () => {
  const repoRoot = join('/', 'repo');
  const groups = [
    {
      projectKey: 'app-a',
      projectRoot: join(repoRoot, 'packages', 'a'),
      files: [join(repoRoot, 'packages', 'a', 'src', 'x.ts')],
    },
    {
      projectKey: 'app-b',
      projectRoot: join(repoRoot, 'packages', 'b'),
      files: [join(repoRoot, 'packages', 'b', 'y.ts'), join(repoRoot, 'packages', 'b', 'z.ts')],
    },
  ];

  it('gives each file its server and display paths, project by project', () => {
    const { projects } = resolveSqaaRunFiles(groups, repoRoot);

    expect(projects.map(({ projectKey }) => projectKey)).toEqual(['app-a', 'app-b']);
    expect(projects[0].files).toEqual([
      {
        absolutePath: groups[0].files[0],
        serverPath: 'src/x.ts',
        displayPath: 'packages/a/src/x.ts',
      },
    ]);
    expect(projects[1].files.map((file) => file.serverPath)).toEqual(['y.ts', 'z.ts']);
  });

  it('derives the display views from the same files', () => {
    const { displayProjects, displayPaths } = resolveSqaaRunFiles(groups, repoRoot);

    expect(displayProjects).toEqual([
      { projectKey: 'app-a', paths: ['packages/a/src/x.ts'] },
      { projectKey: 'app-b', paths: ['packages/b/y.ts', 'packages/b/z.ts'] },
    ]);
    expect(displayPaths).toEqual(['packages/a/src/x.ts', 'packages/b/y.ts', 'packages/b/z.ts']);
  });

  it('returns the one file of a single-file run with its project', () => {
    const run = resolveSqaaRunFiles(groups.slice(0, 1), repoRoot);

    expect(soleFile(run)).toEqual({ projectKey: 'app-a', file: run.projects[0].files[0] });
  });
});
