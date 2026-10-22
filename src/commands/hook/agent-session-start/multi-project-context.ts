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

import { SESSION_START_PROJECT_LIST_LIMIT } from '@/core/config-constants.ts';
import { isAncestorOrSelf } from '@/core/io/fs-utils.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';

const HEADING = '## Multi-project workspace';
const INTRO =
  'This directory contains several SonarQube projects, and `sonar context` commands work on one project at a time.';

/**
 * Lists the project directories up front so the agent needs no extra command to find one; past the
 * limit, points at `sonar link list` to keep the context small.
 */
export function buildMultiProjectContext(
  workspaceRoot: string,
  projects: CompleteProjectMapping[],
  limit = SESSION_START_PROJECT_LIST_LIMIT,
): string {
  if (projects.length > limit) {
    return `${HEADING}

${INTRO} Run them from inside a project's directory. If a command reports that it cannot determine a single project, run \`sonar link list --path <path>\` with the file or directory to work on: it lists the projects at, under or enclosing that path, nearest first, and a single result is the project to use. Then retry from that project's directory.
`;
  }

  const lines = projects
    .map((project) => ({ path: toDisplayPath(workspaceRoot, project.projectRoot), project }))
    .filter(({ path, project }) => isSingleLine(path) && isSingleLine(project.projectKey))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, project }) => `- \`${path}\` (${project.projectKey})`);
  const nestedNote = hasNestedProjects(projects)
    ? "\n\nSome of these projects are nested. A directory inside two of them, or containing another one (such as the outer project's own directory), cannot be resolved to a single project yet; work from a directory that belongs to exactly one of them."
    : '';
  return `${HEADING}

${INTRO} Run them from inside one of these project directories, relative to this directory:

${lines.join('\n')}${nestedNote}
`;
}

/** `.sonar-config.json` is committed, untrusted input: a line break would let it write its own instructions into the agent's context. */
function isSingleLine(value: string): boolean {
  return !/[\r\n]/.test(value);
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
