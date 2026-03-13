/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { resolveAuth } from '../../../lib/auth-resolver';
import { SonarQubeClient } from '../../../sonarqube/client';
import { print } from '../../../ui';
import { MAX_PAGE_SIZE, ProjectsClient } from '../../../sonarqube/projects';
import { InvalidOptionError } from '../_common/error';

export interface ListProjectsOptions {
  query?: string;
  org?: string;
  pageSize: number;
  page: number;
}

/**
 * Projects search command handler
 */
export async function listProjects(options: ListProjectsOptions): Promise<void> {
  const pageSize = options.pageSize;
  if (pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new InvalidOptionError(
      `Invalid --page-size option: '${pageSize}'. Must be an integer between 1 and 500`,
    );
  }

  const page = options.page;
  if (page < 1) {
    throw new InvalidOptionError(`Invalid --page option: '${page}'. Must be an integer >= 1`);
  }

  const resolvedAuth = await resolveAuth({ org: options.org });
  const client = new SonarQubeClient(resolvedAuth.serverUrl, resolvedAuth.token);
  const projectsClient = new ProjectsClient(client);

  const result = await projectsClient.searchProjects({
    q: options.query,
    ps: pageSize,
    p: options.page,
    organization: resolvedAuth.orgKey,
  });

  const hasNextPage = result.paging.pageIndex * result.paging.pageSize < result.paging.total;

  print(
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
}
