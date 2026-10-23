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

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { canonicalizePath } from '@/core/io/fs-utils.ts';
import {
  type CompleteProjectMapping,
  DiscoveredProjects,
} from '@/core/project-discovery/project-discovery-result.ts';

function tempRepo(name: string, subdirs: string[]): string {
  const root = join(tmpdir(), `project-discovery-result-ut-${name}-${Date.now()}`);
  for (const subdir of subdirs) mkdirSync(join(root, subdir), { recursive: true });
  return canonicalizePath(root);
}

function mapping(root: string, subdir: string, projectKey: string): CompleteProjectMapping {
  return {
    projectRoot: join(root, subdir),
    projectKey,
    serverUrl: 'https://sonarcloud.io',
    organization: 'acme',
  };
}

function ownerOf(projects: DiscoveredProjects, path: string): CompleteProjectMapping | undefined {
  return projects.groupByMapping([path]).groups[0]?.mapping;
}

describe('DiscoveredProjects.groupByMapping owner of a single path', () => {
  it('is the mapping whose root contains the path', () => {
    const root = tempRepo('contains', ['packages/a', 'packages/b']);
    const a = mapping(root, 'packages/a', 'acme_a');
    const b = mapping(root, 'packages/b', 'acme_b');

    expect(
      ownerOf(new DiscoveredProjects(root, [a, b]), join(root, 'packages/b/src/index.ts')),
    ).toBe(b);
  });

  it('matches a path equal to the project root', () => {
    const root = tempRepo('self', ['packages/a']);
    const a = mapping(root, 'packages/a', 'acme_a');

    expect(ownerOf(new DiscoveredProjects(root, [a]), a.projectRoot)).toBe(a);
  });

  it('is the deepest root for nested projects regardless of mapping order', () => {
    const root = tempRepo('nested', ['packages/a/inner']);
    const outer = mapping(root, 'packages/a', 'acme_outer');
    const inner = mapping(root, 'packages/a/inner', 'acme_inner');
    const file = join(root, 'packages/a/inner/src/index.ts');

    expect(ownerOf(new DiscoveredProjects(root, [outer, inner]), file)).toBe(inner);
    expect(ownerOf(new DiscoveredProjects(root, [inner, outer]), file)).toBe(inner);
  });

  it('keeps the first entry when two mappings share a root', () => {
    const root = tempRepo('tie', ['packages/a']);
    const first = mapping(root, 'packages/a', 'acme_first');
    const second = mapping(root, 'packages/a', 'acme_second');

    expect(
      ownerOf(new DiscoveredProjects(root, [first, second]), join(root, 'packages/a/x.ts')),
    ).toBe(first);
  });

  it('does not treat a sibling sharing a name prefix as contained', () => {
    const root = tempRepo('prefix', ['packages/app', 'packages/app-extra']);
    const app = mapping(root, 'packages/app', 'acme_app');
    const sibling = join(root, 'packages/app-extra/x.ts');

    expect(new DiscoveredProjects(root, [app]).groupByMapping([sibling])).toEqual({
      groups: [],
      unmapped: [sibling],
    });
  });

  it('matches a path that does not exist on disk', () => {
    const root = tempRepo('missing', ['packages/a']);
    const a = mapping(root, 'packages/a', 'acme_a');

    expect(ownerOf(new DiscoveredProjects(root, [a]), join(root, 'packages/a/deleted.ts'))).toBe(a);
  });
});

describe('DiscoveredProjects.groupByMapping', () => {
  it('groups paths per mapping in first-seen order, preserving path order', () => {
    const root = tempRepo('group', ['packages/a', 'packages/b']);
    const a = mapping(root, 'packages/a', 'acme_a');
    const b = mapping(root, 'packages/b', 'acme_b');
    const bFirst = join(root, 'packages/b/one.ts');
    const aFirst = join(root, 'packages/a/two.ts');
    const bSecond = join(root, 'packages/b/three.ts');

    const { groups, unmapped } = new DiscoveredProjects(root, [a, b]).groupByMapping([
      bFirst,
      aFirst,
      bSecond,
    ]);

    expect(unmapped).toEqual([]);
    expect(groups).toEqual([
      { mapping: b, paths: [bFirst, bSecond] },
      { mapping: a, paths: [aFirst] },
    ]);
  });

  it('returns paths under no mapping separately', () => {
    const root = tempRepo('unmapped', ['packages/a', 'docs']);
    const a = mapping(root, 'packages/a', 'acme_a');
    const inside = join(root, 'packages/a/index.ts');
    const outside = join(root, 'docs/readme.md');

    const { groups, unmapped } = new DiscoveredProjects(root, [a]).groupByMapping([
      outside,
      inside,
    ]);

    expect(groups).toEqual([{ mapping: a, paths: [inside] }]);
    expect(unmapped).toEqual([outside]);
  });

  it('assigns each path to its own nearest project when roots are nested', () => {
    const root = tempRepo('group-nested', ['packages/a/inner']);
    const outer = mapping(root, 'packages/a', 'acme_outer');
    const inner = mapping(root, 'packages/a/inner', 'acme_inner');
    const outerFile = join(root, 'packages/a/index.ts');
    const innerFile = join(root, 'packages/a/inner/index.ts');

    const { groups } = new DiscoveredProjects(root, [outer, inner]).groupByMapping([
      outerFile,
      innerFile,
    ]);

    expect(groups).toEqual([
      { mapping: outer, paths: [outerFile] },
      { mapping: inner, paths: [innerFile] },
    ]);
  });

  it('returns no groups for no paths', () => {
    const root = tempRepo('empty', ['packages/a']);

    expect(
      new DiscoveredProjects(root, [mapping(root, 'packages/a', 'acme_a')]).groupByMapping([]),
    ).toEqual({ groups: [], unmapped: [] });
  });
});

describe('DiscoveredProjects.focusedOn', () => {
  it('keeps every project when run from above them', () => {
    const root = tempRepo('focus-root', ['packages/a', 'packages/b']);
    const a = mapping(root, 'packages/a', 'acme_a');
    const b = mapping(root, 'packages/b', 'acme_b');

    expect(new DiscoveredProjects(root, [a, b]).focusedOn(root).projects).toEqual([a, b]);
  });

  it('keeps only the project run from its root', () => {
    const root = tempRepo('focus-project', ['packages/a', 'packages/b']);
    const a = mapping(root, 'packages/a', 'acme_a');
    const b = mapping(root, 'packages/b', 'acme_b');

    expect(new DiscoveredProjects(root, [a, b]).focusedOn(a.projectRoot).projects).toEqual([a]);
  });

  it('keeps only the project run from a subdirectory of it', () => {
    const root = tempRepo('focus-subdir', ['packages/a/src/main', 'packages/b']);
    const a = mapping(root, 'packages/a', 'acme_a');
    const b = mapping(root, 'packages/b', 'acme_b');

    expect(
      new DiscoveredProjects(root, [a, b]).focusedOn(join(root, 'packages/a/src/main')).projects,
    ).toEqual([a]);
  });

  it('keeps only the closest project when run inside a nested one', () => {
    const root = tempRepo('focus-nested-inside', ['packages/a/inner/src']);
    const outer = mapping(root, 'packages/a', 'acme_outer');
    const inner = mapping(root, 'packages/a/inner', 'acme_inner');

    expect(
      new DiscoveredProjects(root, [outer, inner]).focusedOn(join(root, 'packages/a/inner/src'))
        .projects,
    ).toEqual([inner]);
  });

  it('keeps the project and the projects nested in it when run from its root', () => {
    const root = tempRepo('focus-nested-above', ['packages/a/inner', 'packages/b']);
    const outer = mapping(root, 'packages/a', 'acme_outer');
    const inner = mapping(root, 'packages/a/inner', 'acme_inner');
    const b = mapping(root, 'packages/b', 'acme_b');

    expect(
      new DiscoveredProjects(root, [outer, inner, b]).focusedOn(outer.projectRoot).projects,
    ).toEqual([outer, inner]);
  });

  it('keeps nothing when run from a directory no project touches', () => {
    const root = tempRepo('focus-none', ['packages/a', 'docs']);
    const a = mapping(root, 'packages/a', 'acme_a');

    expect(new DiscoveredProjects(root, [a]).focusedOn(join(root, 'docs')).projects).toEqual([]);
  });

  it('keeps the repository root of the discovery', () => {
    const root = tempRepo('focus-repo-root', ['packages/a']);
    const a = mapping(root, 'packages/a', 'acme_a');

    expect(new DiscoveredProjects(root, [a]).focusedOn(a.projectRoot).repoRoot).toBe(root);
  });
});
