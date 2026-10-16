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

import {
  type BitbucketServerRepositoryResponse,
  type DopSetting,
  ServerImportApiClient,
} from './server-import-api.ts';
import type {
  FetchServerRepositories,
  PlatformSupport,
  ServerRepository,
} from './server-repository.ts';

function toRepository(repo: BitbucketServerRepositoryResponse): ServerRepository {
  const slug = `${repo.projectKey}/${repo.slug}`;
  return {
    id: repo.id === undefined ? slug : String(repo.id),
    name: repo.name,
    slug,
    repositoryIdentifier: repo.slug,
    projectIdentifier: repo.projectKey,
    boundProjectKey: repo.sqProjectKey || undefined,
  };
}

export const bitbucketServerSupport: PlatformSupport = {
  listRepositories(api, setting: DopSetting): FetchServerRepositories {
    let nextStart: number | undefined = 0;
    const buffered: ServerRepository[] = [];
    let served = 0;

    // The unfiltered search pages every project's repositories with an offset. The cursor moves
    // only after a request succeeded, so asking for the same page again after a failure resumes
    // instead of skipping repositories.
    return async (_pageIndex, pageSize) => {
      while (buffered.length < pageSize && nextStart !== undefined) {
        const page = await api.searchBitbucketServerRepos(
          setting.key,
          nextStart,
          ServerImportApiClient.SEARCH_MAX_PAGE_SIZE,
        );
        buffered.push(...page.repositories.map(toRepository));
        nextStart = page.nextStart;
      }
      const repositories = buffered.splice(0, pageSize);
      served += repositories.length;
      return { repositories, total: served + buffered.length };
    };
  },
};
