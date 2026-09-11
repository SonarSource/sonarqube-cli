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

// Issues command - search for SonarQube issues

import {
  type CliError,
  CommandFailedError,
  InvalidOptionError,
} from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { errAsync, type ResultAsync } from '@/core/result.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { MAX_PAGE_SIZE, ProjectsClient } from '@/core/server/projects.ts';

export interface ListProjectsOptions {
  query?: string;
  pageSize: number;
  page: number;
}

/**
 * Projects search command handler
 */
export function listProjects(
  options: ListProjectsOptions,
  ctx: CommandAuthenticatedInvocationContext,
): ResultAsync<void, CliError> {
  const { auth, console } = ctx;
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

  const client = new SonarHttpClient(auth.serverUrl, auth.token);
  const projectsClient = new ProjectsClient(client);

  return projectsClient
    .searchProjects({
      q: options.query,
      ps: pageSize,
      p: options.page,
      organization: auth.orgKey,
    })
    .map((result) => {
      const hasNextPage = result.paging.pageIndex * result.paging.pageSize < result.paging.total;

      console.print(
        JSON.stringify({
          projects: result.components.map((c) => ({ key: c.key, name: c.name })),
          paging: {
            pageIndex: result.paging.pageIndex,
            pageSize: result.paging.pageSize,
            total: result.paging.total,
            hasNextPage,
          },
        }),
      );
    })
    .mapErr((error) => new CommandFailedError(error.message, { cause: error }));
}
