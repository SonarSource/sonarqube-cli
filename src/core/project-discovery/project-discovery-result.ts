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

/** Matches on the same ancestry line as `path`, either direction — no nearest-wins, so a nested path can match more than one. */
function scopeByAncestry<T extends { projectRoot: string }>(mappings: T[], path: string): T[] {
  const target = canonicalizePath(path);
  return mappings.filter(
    (mapping) =>
      isAncestorOrSelf(mapping.projectRoot, target) ||
      isAncestorOrSelf(target, mapping.projectRoot),
  );
}

/**
 * Internal accumulator `discoverProjectMappings()` builds up source by source — `PartialProjectMapping`
 * exists only to support `discoverProject()`'s single-valued fallback. External callers use the
 * `DiscoveredProjects`-returning `discoverProjects()` instead, which never exposes partial matches.
 */
export class ProjectDiscoveryResult {
  repoRoot?: string;
  fromSharedConfig = false;
  projects: ProjectMapping[] = [];

  scope(path: string): ProjectMapping[] {
    return scopeByAncestry(this.projects, path);
  }
}

/** Public discovery result: only `CompleteProjectMapping` — see `ProjectDiscoveryResult`. */
export class DiscoveredProjects {
  constructor(
    public readonly repoRoot: string | undefined,
    public readonly projects: CompleteProjectMapping[],
    /** Whether the projects came from `.sonar-config.json` rather than a single-project source. */
    public readonly fromSharedConfig = false,
  ) {}

  scope(path: string): CompleteProjectMapping[] {
    return scopeByAncestry(this.projects, path);
  }
}
