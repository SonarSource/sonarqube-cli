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

import { relative, sep } from 'node:path';

import { getIntegerConfigValue } from '@/core/config/config-repository.ts';
import { isAncestorOrSelf } from '@/core/io/fs-utils.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';

export const DEFAULT_PROJECT_LIST_LIMIT = 50;

const HEADING = '## Multi-project workspace';
const INTRO =
  'This directory contains several SonarQube projects, and `sonar context` commands work on one project at a time.';

/**
 * Lists the project directories up front so the agent needs no extra command to find one; past the
 * `context.projectListLimit` config value, points at `sonar link list` to keep the context small.
 */
export function buildMultiProjectContext(
  workspaceRoot: string,
  projects: CompleteProjectMapping[],
): string {
  const limit = getIntegerConfigValue('context.projectListLimit', DEFAULT_PROJECT_LIST_LIMIT);
  if (projects.length > limit) {
    return `${HEADING}

${INTRO} Run them from inside a project's directory. If a command reports that it cannot determine a single project, run \`sonar link list --path <path>\` with the file or directory to work on: it lists the projects at, under or enclosing that path, nearest first, and a single result is the project to use. Then retry from that project's directory.
`;
  }

  const lines = projects
    .map((project) => ({ path: toDisplayPath(workspaceRoot, project.projectRoot), project }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, project }) => `- \`${path}\` (${project.projectKey})`);
  const nestedNote = hasNestedProjects(projects)
    ? '\n\nA directory inside two of these projects cannot be resolved to a single project yet.'
    : '';
  return `${HEADING}

${INTRO} Run them from inside one of these project directories, relative to this directory:

${lines.join('\n')}${nestedNote}
`;
}

function toDisplayPath(workspaceRoot: string, projectRoot: string): string {
  const rel = relative(workspaceRoot, projectRoot);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

function hasNestedProjects(projects: CompleteProjectMapping[]): boolean {
  return projects.some((outer) =>
    projects.some(
      (inner) => inner !== outer && isAncestorOrSelf(outer.projectRoot, inner.projectRoot),
    ),
  );
}
