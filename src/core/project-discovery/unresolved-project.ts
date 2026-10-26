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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';

import type { DiscoveredProjects } from './project-discovery-result.ts';

/** For a command that needs one project when `.sonar-config.json` links none or several covering `path`. */
export function unresolvedProjectError(
  discovered: DiscoveredProjects,
  path: string,
): CommandFailedError {
  return new CommandFailedError(
    `Could not determine a single SonarQube project for ${canonicalizePath(path)}.`,
    { remediationHint: unresolvedProjectHint(discovered, path) },
  );
}

function unresolvedProjectHint(discovered: DiscoveredProjects, path: string): string {
  const dir = canonicalizePath(path);
  const scoped = discovered.scope(dir);
  if (scoped.length === 0) {
    return (
      `${dir} is not inside any project linked in .sonar-config.json. ` +
      `Run 'sonar link list' from the repository root (${discovered.repoRoot ?? dir}) to see where they are.`
    );
  }
  const enclosingCount = scoped.filter((project) => project.contains).length;
  if (enclosingCount > 1) {
    return (
      `${dir} is inside ${enclosingCount} nested projects, which are not supported yet. ` +
      "Run 'sonar link list' to list them, then work from a directory that belongs to only one."
    );
  }
  return (
    `${scoped.length} projects are linked at or under ${dir}. ` +
    "Run 'sonar link list --path <path>' with the file or directory to work on; a single result is its project. " +
    "Then re-run from that project's directory."
  );
}
