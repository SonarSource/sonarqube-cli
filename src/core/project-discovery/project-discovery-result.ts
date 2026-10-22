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

import { canonicalizePath, isAncestorOrSelf } from '@/core/io/fs-utils.ts';

/** Both `projectKey` and `serverUrl` present — what `discoverProject()` requires. */
export interface CompleteProjectMapping {
  projectRoot: string;
  projectKey: string;
  serverUrl: string;
  organization?: string;
}

/** `projectKey`/`serverUrl` not guaranteed — `discoverServer()`/`discoverOrganization()` never need `projectKey`, so they accept this directly. */
export interface PartialProjectMapping {
  /** True only after an authenticated remote lookup succeeds with no bindings. */
  gitRemoteBindingNotFound?: boolean;
  projectRoot: string;
  projectKey?: string;
  serverUrl?: string;
  organization?: string;
}

export type ProjectMapping = CompleteProjectMapping | PartialProjectMapping;

export function isCompleteProjectMapping(
  mapping: ProjectMapping,
): mapping is CompleteProjectMapping {
  return mapping.projectKey !== undefined && mapping.serverUrl !== undefined;
}

export function isSameConnection(mappings: ProjectMapping[]): boolean {
  const [first, ...rest] = mappings;
  return rest.every(
    (mapping) =>
      mapping.serverUrl === first.serverUrl && mapping.organization === first.organization,
  );
}

/** A mapping on the ancestry line of a scoped path. */
export type ScopedProjectMapping<T> = T & {
  /** The project root is the path or encloses it, rather than sitting below it. */
  contains: boolean;
};

/** Matches on the same ancestry line as `path`, either direction — no nearest-wins, so a nested path can match more than one. */
function scopeByAncestry<T extends { projectRoot: string }>(
  mappings: T[],
  path: string,
): ScopedProjectMapping<T>[] {
  const target = canonicalizePath(path);
  return mappings.flatMap((mapping) => {
    const contains = isAncestorOrSelf(mapping.projectRoot, target);
    return contains || isAncestorOrSelf(target, mapping.projectRoot)
      ? [{ ...mapping, contains }]
      : [];
  });
}

/** Nearest-wins counterpart to `scopeByAncestry`: the deepest mapping root containing `path`; a tie keeps the first in file order. */
function selectMappingForPath<T extends { projectRoot: string }>(
  mappings: T[],
  path: string,
): T | undefined {
  const target = canonicalizePath(path);
  let selected: T | undefined;
  for (const mapping of mappings) {
    if (!isAncestorOrSelf(mapping.projectRoot, target)) continue;
    // Roots that contain the same path are prefixes of it, so the longer one is the deeper one.
    if (selected === undefined || mapping.projectRoot.length > selected.projectRoot.length) {
      selected = mapping;
    }
  }
  return selected;
}

/** Paths sharing one mapping, as given by the caller (not canonicalized). */
export interface MappingGroup<T extends { projectRoot: string }> {
  mapping: T;
  paths: string[];
}

export interface MappingGroups<T extends { projectRoot: string }> {
  /** In order of the first path that selected each mapping. */
  groups: MappingGroup<T>[];
  /** Paths under no mapping's root. */
  unmapped: string[];
}

function groupPathsByMapping<T extends { projectRoot: string }>(
  mappings: T[],
  paths: string[],
): MappingGroups<T> {
  const byMapping = new Map<T, string[]>();
  const unmapped: string[] = [];
  for (const path of paths) {
    const mapping = selectMappingForPath(mappings, path);
    if (mapping === undefined) {
      unmapped.push(path);
      continue;
    }
    const grouped = byMapping.get(mapping);
    if (grouped) grouped.push(path);
    else byMapping.set(mapping, [path]);
  }
  return {
    groups: [...byMapping].map(([mapping, grouped]) => ({ mapping, paths: grouped })),
    unmapped,
  };
}

/**
 * Internal accumulator `discoverProjectMappings()` builds up source by source — `PartialProjectMapping`
 * exists only to support `discoverProject()`'s single-valued fallback. External callers use the
 * `DiscoveredProjects`-returning `discoverProjects()` instead, which never exposes partial matches.
 */
export class ProjectDiscoveryResult {
  repoRoot?: string;
  projects: ProjectMapping[] = [];

  scope(path: string): ScopedProjectMapping<ProjectMapping>[] {
    return scopeByAncestry(this.projects, path);
  }
}

/** Public discovery result: only `CompleteProjectMapping` — see `ProjectDiscoveryResult`. */
export class DiscoveredProjects {
  constructor(
    public readonly repoRoot: string | undefined,
    public readonly projects: CompleteProjectMapping[],
  ) {}

  scope(path: string): ScopedProjectMapping<CompleteProjectMapping>[] {
    return scopeByAncestry(this.projects, path);
  }

  /** The single mapping owning `path` (nearest root wins), unlike `scope()`, which keeps every mapping on the same ancestry line. */
  mappingFor(path: string): CompleteProjectMapping | undefined {
    return selectMappingForPath(this.projects, path);
  }

  /** `mappingFor()` applied to each path, for callers that fan work out per project. */
  groupByMapping(paths: string[]): MappingGroups<CompleteProjectMapping> {
    return groupPathsByMapping(this.projects, paths);
  }
}
