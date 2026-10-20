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

import { isAbsolute, relative, sep } from 'node:path';

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolvePageOptions } from '@/core/commands/params.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import { discoverProjects } from '@/core/project-discovery/project-info.ts';
import { hasNextPage } from '@/core/server/paging.ts';

import { resolveExistingPath } from './resolve-link.ts';

export const DEFAULT_LINK_LIST_PAGE_SIZE = 20;
export const MAX_LINK_LIST_PAGE_SIZE = 100;

export interface LinkListOptions {
  near?: string;
  pattern?: string;
  page: number;
  pageSize: number;
}

/** Lists linked projects nearest to `--near` first, one page at a time so a large monorepo never prints everything. */
export async function listLinks(
  options: LinkListOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { page, pageSize } = resolvePageOptions(
    options.pageSize,
    options.page,
    MAX_LINK_LIST_PAGE_SIZE,
  ).match(
    (value) => value,
    (error) => {
      throw error;
    },
  );
  const near = resolveExistingPath(options.near ?? process.cwd());
  const pattern = compilePattern(options.pattern);

  const discovered = await discoverProjects(process.cwd(), {
    auth: ctx.auth,
    silent: true,
    console: ctx.console,
  });
  const matching = discovered.projects
    .filter((project) => matchesPattern(project, pattern))
    .map((project) => ({ project, distance: treeDistance(near, project.projectRoot) }))
    .sort(
      (a, b) =>
        a.distance - b.distance || a.project.projectRoot.localeCompare(b.project.projectRoot),
    )
    .map(({ project }) => project);

  const start = (page - 1) * pageSize;
  const paging = { pageIndex: page, pageSize, total: matching.length };
  ctx.console.print(
    JSON.stringify({
      projects: matching.slice(start, start + pageSize),
      paging: { ...paging, hasNextPage: hasNextPage(paging) },
    }),
  );
}

function compilePattern(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) {
    return undefined;
  }
  try {
    return new RegExp(pattern, 'i');
  } catch (error) {
    throw new InvalidOptionError(
      `Invalid --pattern option: ${(error as Error).message}`,
      'Pass a regular expression matched against project keys and directories, e.g. --pattern "api".',
    );
  }
}

function matchesPattern(project: CompleteProjectMapping, pattern: RegExp | undefined): boolean {
  return (
    pattern === undefined || pattern.test(project.projectKey) || pattern.test(project.projectRoot)
  );
}

/** Directory hops between `from` and `to`; another drive sorts last. */
function treeDistance(from: string, to: string): number {
  const rel = relative(from, to);
  if (rel === '') {
    return 0;
  }
  return isAbsolute(rel) ? Number.POSITIVE_INFINITY : rel.split(sep).length;
}
