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

/**
 * One resolved project binding — what `ProjectDiscoveryResult.projects` holds, possibly more
 * than one per call. `projectKey` is absent for an otherwise-incomplete single-valued match
 * (e.g. a `sonar-project.properties` with a host URL but no project key) — still worth keeping
 * so `discoverServer()`/`discoverOrganization()` can read its `serverUrl`/`organization`.
 */
export interface ProjectMapping {
  projectRoot: string;
  projectKey?: string;
  serverUrl?: string;
  organization?: string;
}

/** Mutable accumulator `discoverProjects()` builds up source by source, then returns as-is. */
export class ProjectDiscoveryResult {
  repoRoot?: string;
  projects: ProjectMapping[] = [];

  /** Projects on the same ancestry line as `directory`, either direction — narrows deep inside one project, broadens above several siblings. */
  scope(directory: string): ProjectMapping[] {
    const target = canonicalizePath(directory);
    return this.projects.filter(
      (project) =>
        isAncestorOrSelf(project.projectRoot, target) ||
        isAncestorOrSelf(target, project.projectRoot),
    );
  }
}
