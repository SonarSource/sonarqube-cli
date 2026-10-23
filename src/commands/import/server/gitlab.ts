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

import type { GitlabRepositoryResponse } from './server-import-api.ts';
import type {
  FetchServerRepositories,
  PlatformSupport,
  ServerRepository,
} from './server-repository.ts';

function toRepository(repo: GitlabRepositoryResponse): ServerRepository {
  const id = String(repo.id);
  return {
    id,
    name: repo.name,
    slug: repo.pathSlug ? `${repo.pathSlug}/${repo.slug}` : repo.slug,
    repositoryIdentifier: id,
    boundProjectKey: repo.sqProjectKey || undefined,
  };
}

export const gitlabSupport: PlatformSupport = {
  listRepositories(api, setting): FetchServerRepositories {
    return async (pageIndex, pageSize) => {
      const page = await api.searchGitlabRepos(setting.key, pageIndex, pageSize);
      return {
        repositories: page.repositories.map(toRepository),
        total: page.total ?? page.repositories.length,
      };
    };
  },
};
