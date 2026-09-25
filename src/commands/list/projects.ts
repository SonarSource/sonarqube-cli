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

// Projects command - search for SonarQube projects

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveFormatOption } from '@/core/commands/parsing.ts';
import { errAsync, type ResultAsync } from '@/core/result.ts';
import { MAX_PAGE_SIZE, ProjectsClient } from '@/core/server/projects.ts';
import { columnFormatting } from '@/core/ui/formatter/column-formatting.ts';

const MIN_KEY_WIDTH = 20;

export const VALID_FORMATS = ['json', 'table'] as const;

export interface ListProjectsOptions {
  query?: string;
  format?: string;
  pageSize: number;
  page: number;
}

interface ProjectSummary {
  key: string;
  name: string;
}

function formatTable(projects: ProjectSummary[]): string {
  if (projects.length === 0) {
    return 'No projects found';
  }

  const [keyWidth] = columnFormatting([projects.map((p) => p.key)], [MIN_KEY_WIDTH]);

  const header = ['KEY'.padEnd(keyWidth), 'NAME'].join(' | ');
  const separator = '-'.repeat(header.length);

  const lines = [header, separator];
  for (const project of projects) {
    lines.push([project.key.padEnd(keyWidth), project.name].join(' | '));
  }

  return lines.join('\n');
}

/**
 * Projects search command handler
 */
export function listProjects(
  options: ListProjectsOptions,
  ctx: CommandAuthenticatedInvocationContext,
): ResultAsync<void, Error> {
  const { auth, console } = ctx;

  let format: (typeof VALID_FORMATS)[number];
  try {
    format = resolveFormatOption(options.format, VALID_FORMATS, 'json');
  } catch (err) {
    return errAsync(err as InvalidOptionError);
  }

  const pageSize = options.pageSize;
  if (pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return errAsync(
      new InvalidOptionError(
        `Invalid --page-size option: '${pageSize}'. Must be an integer between 1 and 500`,
      ),
    );
  }

  const page = options.page;
  if (page < 1) {
    return errAsync(
      new InvalidOptionError(`Invalid --page option: '${page}'. Must be an integer >= 1`),
    );
  }

  const projectsClient = new ProjectsClient(ctx.connection.httpClient);

  return projectsClient
    .searchProjects({
      q: options.query,
      ps: pageSize,
      p: options.page,
      organization: auth.orgKey,
    })
    .map((result) => {
      const hasNextPage = result.paging.pageIndex * result.paging.pageSize < result.paging.total;
      const projects = result.components.map((c) => ({ key: c.key, name: c.name }));

      if (format === 'table') {
        console.print(formatTable(projects));
        return;
      }

      console.print(
        JSON.stringify({
          projects,
          paging: {
            pageIndex: result.paging.pageIndex,
            pageSize: result.paging.pageSize,
            total: result.paging.total,
            hasNextPage,
          },
        }),
      );
    });
}
