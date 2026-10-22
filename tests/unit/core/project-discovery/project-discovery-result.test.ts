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

describe('DiscoveredProjects.mappingFor', () => {
  it('returns the mapping whose root contains the path', () => {
    const root = tempRepo('contains', ['packages/a', 'packages/b']);
    const a = mapping(root, 'packages/a', 'acme_a');
    const b = mapping(root, 'packages/b', 'acme_b');
    const projects = new DiscoveredProjects(root, [a, b]);

    expect(projects.mappingFor(join(root, 'packages/b/src/index.ts'))).toBe(b);
  });

  it('matches a path equal to the project root', () => {
    const root = tempRepo('self', ['packages/a']);
    const a = mapping(root, 'packages/a', 'acme_a');

    expect(new DiscoveredProjects(root, [a]).mappingFor(a.projectRoot)).toBe(a);
  });

  it('picks the deepest root for nested projects regardless of file order', () => {
    const root = tempRepo('nested', ['packages/a/inner']);
    const outer = mapping(root, 'packages/a', 'acme_outer');
    const inner = mapping(root, 'packages/a/inner', 'acme_inner');
    const file = join(root, 'packages/a/inner/src/index.ts');

    expect(new DiscoveredProjects(root, [outer, inner]).mappingFor(file)).toBe(inner);
    expect(new DiscoveredProjects(root, [inner, outer]).mappingFor(file)).toBe(inner);
  });

  it('still selects the outer project for files beside the nested one', () => {
    const root = tempRepo('beside', ['packages/a/inner']);
    const outer = mapping(root, 'packages/a', 'acme_outer');
    const inner = mapping(root, 'packages/a/inner', 'acme_inner');

    expect(
      new DiscoveredProjects(root, [outer, inner]).mappingFor(join(root, 'packages/a/index.ts')),
    ).toBe(outer);
  });

  it('keeps the first entry when two mappings share a root', () => {
    const root = tempRepo('tie', ['packages/a']);
    const first = mapping(root, 'packages/a', 'acme_first');
    const second = mapping(root, 'packages/a', 'acme_second');

    expect(
      new DiscoveredProjects(root, [first, second]).mappingFor(join(root, 'packages/a/x.ts')),
    ).toBe(first);
  });

  it('returns undefined for a path under no mapping', () => {
    const root = tempRepo('none', ['packages/a', 'docs']);
    const projects = new DiscoveredProjects(root, [mapping(root, 'packages/a', 'acme_a')]);

    expect(projects.mappingFor(join(root, 'docs/readme.md'))).toBeUndefined();
  });

  it('does not treat a sibling sharing a name prefix as contained', () => {
    const root = tempRepo('prefix', ['packages/app', 'packages/app-extra']);
    const app = mapping(root, 'packages/app', 'acme_app');

    expect(
      new DiscoveredProjects(root, [app]).mappingFor(join(root, 'packages/app-extra/x.ts')),
    ).toBeUndefined();
  });

  it('matches a path that does not exist on disk', () => {
    const root = tempRepo('missing', ['packages/a']);
    const a = mapping(root, 'packages/a', 'acme_a');

    expect(new DiscoveredProjects(root, [a]).mappingFor(join(root, 'packages/a/deleted.ts'))).toBe(
      a,
    );
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
