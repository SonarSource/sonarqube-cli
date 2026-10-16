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
  type BitbucketServerProjectResponse,
  type BitbucketServerRepositoryResponse,
  type DopSetting,
  ServerImportApiClient,
} from './server-import-api.ts';
import type {
  FetchServerRepositories,
  PlatformSupport,
  ServerRepository,
  ServerRepositoryPage,
} from './server-repository.ts';

const PROJECT_START = 0;

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

/**
 * Bitbucket Server lists projects, then the repositories of each project, both with their own
 * offset paging. This walks that two-level listing and cuts it into flat pages. Every cursor
 * moves only after its request succeeded, so a failed request leaves everything fetched so far
 * in place and asking for the same page again resumes instead of skipping repositories.
 */
class BitbucketServerRepositoryLister {
  private projectStart: number | undefined = PROJECT_START;
  private readonly pendingProjects: BitbucketServerProjectResponse[] = [];
  private current: { project: BitbucketServerProjectResponse; start: number } | undefined;
  private readonly buffered: ServerRepository[] = [];
  private served = 0;

  constructor(
    private readonly api: ServerImportApiClient,
    private readonly settingKey: string,
  ) {}

  async fetchPage(pageSize: number): Promise<ServerRepositoryPage> {
    await this.fillBuffer(pageSize);
    const repositories = this.buffered.splice(0, pageSize);
    this.served += repositories.length;
    return { repositories, total: this.served + this.buffered.length };
  }

  /** Keeps requesting until a full page is buffered or the server has nothing left. */
  private async fillBuffer(wanted: number): Promise<void> {
    if (this.buffered.length >= wanted || !(await this.fetchMore())) return;
    await this.fillBuffer(wanted);
  }

  /** Runs the next request of the walk; false once there is none left. */
  private async fetchMore(): Promise<boolean> {
    if (this.current) {
      await this.fetchRepositories(this.current.project, this.current.start);
      return true;
    }
    const project = this.pendingProjects.shift();
    if (project) {
      this.current = { project, start: PROJECT_START };
      return true;
    }
    if (this.projectStart === undefined) {
      return false;
    }
    await this.fetchProjects(this.projectStart);
    return true;
  }

  private async fetchProjects(start: number): Promise<void> {
    const page = await this.api.listBitbucketServerProjects(
      this.settingKey,
      start,
      ServerImportApiClient.SEARCH_MAX_PAGE_SIZE,
    );
    this.pendingProjects.push(...page.projects);
    this.projectStart = page.nextStart;
  }

  private async fetchRepositories(
    project: BitbucketServerProjectResponse,
    start: number,
  ): Promise<void> {
    const page = await this.api.searchBitbucketServerRepos(
      this.settingKey,
      project.name,
      start,
      ServerImportApiClient.SEARCH_MAX_PAGE_SIZE,
    );
    // The name filter can match other projects too; each is listed on its own turn.
    this.buffered.push(
      ...page.repositories.filter((repo) => repo.projectKey === project.key).map(toRepository),
    );
    this.current = page.nextStart === undefined ? undefined : { project, start: page.nextStart };
  }
}

export const bitbucketServerSupport: PlatformSupport = {
  listRepositories(api, setting: DopSetting): FetchServerRepositories {
    const lister = new BitbucketServerRepositoryLister(api, setting.key);
    return (_pageIndex, pageSize) => lister.fetchPage(pageSize);
  },
};
