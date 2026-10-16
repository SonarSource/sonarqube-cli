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

import { type GithubRepositoryResponse, ServerImportApiClient } from './server-import-api.ts';
import type {
  FetchServerRepositories,
  PlatformSupport,
  ServerRepository,
} from './server-repository.ts';

const SERVER_PAGE_SIZE = ServerImportApiClient.SEARCH_MAX_PAGE_SIZE;

function toRepository(repo: GithubRepositoryResponse): ServerRepository {
  return {
    id: String(repo.id),
    name: repo.name,
    slug: repo.key,
    repositoryIdentifier: repo.key,
    boundProjectKey: repo.sqProjectKey || undefined,
  };
}

/**
 * GitHub lists organizations, then the repositories of each one. This walks them in order and
 * serves the result as flat pages. Fetched repositories wait in `buffer` until a page is
 * returned, so a failed request leaves everything fetched so far in place for the retry.
 */
export const githubSupport: PlatformSupport = {
  listRepositories(api, setting): FetchServerRepositories {
    const organizations: string[] = [];
    let nextOrganizationsPage = 1;
    let organizationsDone = false;

    let organizationIndex = 0;
    let nextRepositoriesPage = 1;
    let repositoriesFetchedInOrganization = 0;

    const buffer: ServerRepository[] = [];
    let listed = 0;

    async function loadOrganizations(): Promise<void> {
      const page = await api.listGithubOrganizations(
        setting.key,
        nextOrganizationsPage,
        SERVER_PAGE_SIZE,
      );
      organizations.push(...page.organizations.map((organization) => organization.key));
      nextOrganizationsPage++;
      organizationsDone =
        page.organizations.length < SERVER_PAGE_SIZE ||
        (page.total !== undefined && organizations.length >= page.total);
    }

    async function loadRepositories(organization: string): Promise<void> {
      const page = await api.listGithubRepositories(
        setting.key,
        organization,
        nextRepositoriesPage,
        SERVER_PAGE_SIZE,
      );
      buffer.push(...page.repositories.map(toRepository));
      listed += page.repositories.length;
      repositoriesFetchedInOrganization += page.repositories.length;
      nextRepositoriesPage++;

      const organizationDone =
        page.repositories.length < SERVER_PAGE_SIZE ||
        (page.total !== undefined && repositoriesFetchedInOrganization >= page.total);
      if (organizationDone) {
        organizationIndex++;
        nextRepositoriesPage = 1;
        repositoriesFetchedInOrganization = 0;
      }
    }

    async function fill(wanted: number): Promise<void> {
      while (buffer.length < wanted) {
        if (organizationIndex < organizations.length) {
          await loadRepositories(organizations[organizationIndex]);
        } else if (organizationsDone) {
          return;
        } else {
          await loadOrganizations();
        }
      }
    }

    return async (_pageIndex, pageSize) => {
      await fill(pageSize);
      const repositories = buffer.splice(0, pageSize);
      // The server has no count across organizations: this is what has been listed so far.
      return { repositories, total: listed };
    };
  },
};
