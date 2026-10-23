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

import { existsSync, statSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolvePageOptions } from '@/core/commands/params.ts';
import { canonicalizePath } from '@/core/io/fs-utils.ts';
import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';
import { discoverProjects } from '@/core/project-discovery/project-info.ts';
import { hasNextPage } from '@/core/server/paging.ts';

export const DEFAULT_LINK_LIST_PAGE_SIZE = 20;
export const MAX_LINK_LIST_PAGE_SIZE = 100;

export interface LinkListOptions {
  path?: string;
  pattern?: string;
  page: number;
  pageSize: number;
}

/**
 * Lists the projects at, under or enclosing `--path` (a file or directory), nearest first, one
 * page at a time so a large monorepo never prints everything. `contains` tells enclosing projects
 * apart from ones below the path.
 */
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
  const { path, startDir } = resolvePathOption(options.path);
  const pattern = compilePattern(options.pattern);

  const discovered = await discoverProjects(startDir, {
    auth: ctx.auth,
    silent: true,
    console: ctx.console,
  });
  const patternBaseDir = discovered.repoRoot ?? canonicalizePath(process.cwd());
  const matching = discovered
    .scope(path)
    .filter((project) => matchesPattern(project, patternBaseDir, pattern))
    .map((project) => ({ project, distance: treeDistance(path, project.projectRoot) }))
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

/** Discovery starts from the directory of a file `--path`, so a file resolves like its directory. */
function resolvePathOption(rawPath: string | undefined): { path: string; startDir: string } {
  const requested = rawPath ?? process.cwd();
  if (!existsSync(requested)) {
    throw new InvalidOptionError(`Path "${requested}" does not exist.`);
  }
  const path = canonicalizePath(requested);
  return { path, startDir: statSync(path).isDirectory() ? path : dirname(path) };
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
      'Pass a regular expression matched against project keys and directories relative to the repository root (the current directory outside a git repository), e.g. --pattern "api".',
    );
  }
}

/** Directories match relative to `baseDir`, so the checkout path above the repository never matches. */
function matchesPattern(
  project: CompleteProjectMapping,
  baseDir: string,
  pattern: RegExp | undefined,
): boolean {
  if (pattern === undefined) {
    return true;
  }
  const directory = relative(baseDir, project.projectRoot).split(sep).join('/') || '.';
  return pattern.test(project.projectKey) || pattern.test(directory);
}

/** Directory hops between two paths on the same ancestry line. */
function treeDistance(from: string, to: string): number {
  const rel = relative(from, to);
  return rel === '' ? 0 : rel.split(sep).length;
}
