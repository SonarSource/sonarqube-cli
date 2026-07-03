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

import { type DopRepository, SonarQubeClient } from '../../../../sonarqube/client';

const REPOSITORY_LOCAL_PAGE_SIZE = 10;

type FetchPage = (
  pageIndex: number,
  pageSize: number,
) => Promise<{ repositories: DopRepository[]; total: number }>;

/**
 * Locally paginates repositories for the `sonar import` select prompt, fetching
 * server pages (up to `SonarQubeClient.DOP_REPOSITORIES_MAX_PAGE_SIZE` at a time)
 * lazily as the user pages through, rather than loading the entire remote list
 * up front.
 */
export class RepositoryCollection {
  private readonly repos: DopRepository[] = [];
  private readonly fetchPage: FetchPage;
  private readonly pageSize: number;
  private page = 1;
  private serverPageIndex = 1;
  private total: number | null = null;

  private constructor(fetchPage: FetchPage, pageSize: number) {
    this.fetchPage = fetchPage;
    this.pageSize = pageSize;
  }

  /** Create a collection and eagerly load just enough repos for the first visible page. */
  static async create(
    fetchPage: FetchPage,
    pageSize = REPOSITORY_LOCAL_PAGE_SIZE,
  ): Promise<RepositoryCollection> {
    const collection = new RepositoryCollection(fetchPage, pageSize);
    await collection.ensureLoaded();
    return collection;
  }

  /** Total number of repositories across all server pages (unaffected by pagination). */
  get length(): number {
    return this.total ?? 0;
  }

  /** Repositories visible up to and including the current page. */
  get visible(): DopRepository[] {
    return this.repos.slice(0, this.page * this.pageSize);
  }

  /** True when there are more repositories beyond the current visible window. */
  get hasMore(): boolean {
    return this.page * this.pageSize < this.length;
  }

  /** Advance the visible window by one page, fetching more server pages if needed. */
  async loadMore(): Promise<void> {
    if (!this.hasMore) return;
    this.page++;
    await this.ensureLoaded();
  }

  private async ensureLoaded(): Promise<void> {
    const needed = this.page * this.pageSize;
    while (this.repos.length < needed && (this.total === null || this.repos.length < this.total)) {
      const { repositories, total } = await this.fetchPage(
        this.serverPageIndex,
        SonarQubeClient.DOP_REPOSITORIES_MAX_PAGE_SIZE,
      );
      this.repos.push(...repositories);
      this.serverPageIndex++;
      // Trust the loaded count once the server stops returning full pages, so
      // `hasMore` never over-reports beyond what actually exists (guards against
      // an inconsistent/stale server-reported total causing wasted "Load more" fetches).
      if (repositories.length < SonarQubeClient.DOP_REPOSITORIES_MAX_PAGE_SIZE) {
        this.total = this.repos.length;
        break;
      }
      this.total = total;
    }
  }
}
