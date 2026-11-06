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
import logger from '@/core/observability/logger.ts';

import {
  type DopSetting,
  type GithubRepositoryResponse,
  ServerImportApiClient,
} from './server-import-api.ts';
import type {
  FetchServerRepositories,
  PlatformSupport,
  ServerRepository,
} from './server-repository.ts';

const SERVER_PAGE_SIZE = ServerImportApiClient.SEARCH_MAX_PAGE_SIZE;
// The server lists repositories through GitHub's search API, which rejects any page past 1000 results.
const GITHUB_SEARCH_RESULT_CAP = 1000;

function toRepository(repo: GithubRepositoryResponse): ServerRepository {
  return {
    id: String(repo.id),
    name: repo.name,
    slug: repo.key,
    repositoryIdentifier: repo.key,
    boundProjectKey: repo.sqProjectKey || undefined,
  };
}

async function listVisibleOrganizations(
  api: ServerImportApiClient,
  setting: DopSetting,
  pageIndex = 1,
  organizations = new Set<string>(),
): Promise<Set<string>> {
  const page = await api.listGithubOrganizations(setting.key, pageIndex, SERVER_PAGE_SIZE);
  page.organizations.forEach((entry) => organizations.add(entry.key));
  if (
    page.organizations.length < SERVER_PAGE_SIZE ||
    (page.total !== undefined && pageIndex * SERVER_PAGE_SIZE >= page.total)
  )
    return organizations;
  return listVisibleOrganizations(api, setting, pageIndex + 1, organizations);
}

async function findExplicitRepository(
  api: ServerImportApiClient,
  setting: DopSetting,
  slug: string,
  pageIndex = 1,
): Promise<ServerRepository[]> {
  const parts = slug.split('/');
  const [organization, name] = parts;
  if (parts.length !== 2 || !organization || !name) return [];
  const page = await api.listGithubRepositories(
    setting.key,
    organization,
    pageIndex,
    SERVER_PAGE_SIZE,
    name,
  );
  const match = page.repositories.find((repository) => repository.key === slug);
  if (match) return [toRepository(match)];
  const fetched = pageIndex * SERVER_PAGE_SIZE;
  if (fetched >= GITHUB_SEARCH_RESULT_CAP && (page.total === undefined || page.total > fetched)) {
    throw new CommandFailedError(
      `GitHub repository lookup is incomplete for '${slug}': only the first ${GITHUB_SEARCH_RESULT_CAP} filtered search results can be listed. The repository may exist beyond this limit.`,
    );
  }
  if (
    page.repositories.length < SERVER_PAGE_SIZE ||
    (page.total !== undefined && fetched >= page.total) ||
    fetched >= GITHUB_SEARCH_RESULT_CAP
  )
    return [];
  return findExplicitRepository(api, setting, slug, pageIndex + 1);
}

/**
 * GitHub lists organizations, then the repositories of each one. This walks them in order and
 * serves the result as flat pages. Fetched repositories wait in `buffer` until a page is
 * returned, so a failed request leaves everything fetched so far in place for the retry.
 */
export const githubSupport: PlatformSupport = {
  listRepositories(api, setting, slugs): FetchServerRepositories {
    if (slugs?.length) {
      let resolved: Promise<ServerRepository[]> | undefined;
      return async (pageIndex, pageSize) => {
        resolved ??= listVisibleOrganizations(api, setting).then(async (organizations) => {
          const matches = await Promise.all(
            slugs
              .filter((slug) => organizations.has(slug.split('/')[0]))
              .map((slug) => findExplicitRepository(api, setting, slug)),
          );
          return matches.flat();
        });
        const repositories = await resolved;
        const start = (pageIndex - 1) * pageSize;
        return {
          repositories: repositories.slice(start, start + pageSize),
          total: repositories.length,
        };
      };
    }
    const warnings: string[] = [];
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
        (page.total !== undefined && repositoriesFetchedInOrganization >= page.total) ||
        repositoriesFetchedInOrganization >= GITHUB_SEARCH_RESULT_CAP;
      if (
        repositoriesFetchedInOrganization >= GITHUB_SEARCH_RESULT_CAP &&
        (page.total === undefined || page.total > repositoriesFetchedInOrganization)
      ) {
        const warning = `GitHub repository discovery is incomplete for organization '${organization}': only the first ${GITHUB_SEARCH_RESULT_CAP} search results can be listed. Use --repo owner/repository to select a repository directly.`;
        warnings.push(warning);
        logger.warn(warning);
      }
      if (organizationDone) {
        organizationIndex++;
        nextRepositoriesPage = 1;
        repositoriesFetchedInOrganization = 0;
      }
    }

    async function fill(wanted: number): Promise<void> {
      if (buffer.length >= wanted) return;
      if (organizationIndex < organizations.length) {
        await loadRepositories(organizations[organizationIndex]);
      } else if (organizationsDone) {
        return;
      } else {
        await loadOrganizations();
      }
      await fill(wanted);
    }

    return async (_pageIndex, pageSize) => {
      await fill(pageSize);
      const repositories = buffer.splice(0, pageSize);
      // The server has no count across organizations: this is what has been listed so far.
      return {
        repositories,
        total: listed,
        ...(warnings.length ? { warnings: [...warnings] } : {}),
      };
    };
  },
};
