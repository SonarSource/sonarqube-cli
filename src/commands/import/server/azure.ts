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

import type { AzureRepositoryResponse } from './server-import-api.ts';
import type {
  FetchServerRepositories,
  PlatformSupport,
  ServerRepository,
} from './server-repository.ts';

// Azure DevOps repositories are only unique within their project, and the server identifies them
// by name: `repositoryIdentifier` is the repository name, `projectIdentifier` the project name.
function toRepository(repo: AzureRepositoryResponse): ServerRepository {
  const slug = `${repo.projectName}/${repo.name}`;
  return {
    id: slug,
    name: repo.name,
    slug,
    repositoryIdentifier: repo.name,
    projectIdentifier: repo.projectName,
    boundProjectKey: repo.sqProjectKey || undefined,
  };
}

export const azureSupport: PlatformSupport = {
  listRepositories(api, setting): FetchServerRepositories {
    let projectNames: string[] | undefined;
    let nextProject = 0;
    const loaded: ServerRepository[] = [];

    // Neither endpoint is paged, and every repository needs one request per project: they are
    // all read on the first call so the total is exact. A project only counts as read once its
    // repositories are in, so a call that failed is simply made again.
    async function readRemainingProjects(names: string[]): Promise<void> {
      if (nextProject >= names.length) return;
      const repos = await api.searchAzureRepos(setting.key, names[nextProject]);
      loaded.push(...repos.map(toRepository));
      nextProject++;
      await readRemainingProjects(names);
    }

    return async (pageIndex, pageSize) => {
      projectNames ??= (await api.listAzureProjects(setting.key)).map((project) => project.name);
      await readRemainingProjects(projectNames);
      const start = (pageIndex - 1) * pageSize;
      return { repositories: loaded.slice(start, start + pageSize), total: loaded.length };
    };
  },
};
