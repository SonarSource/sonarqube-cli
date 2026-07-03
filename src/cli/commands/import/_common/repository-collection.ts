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

import type { DopRepository } from '../../../../sonarqube/client';

const REPOSITORY_LOCAL_PAGE_SIZE = 10;

/** Locally paginates repositories for the `sonar import` select prompt. */
export class RepositoryCollection {
  private readonly repos: DopRepository[];
  private readonly pageSize: number;
  private page: number;

  constructor(repos: DopRepository[], pageSize = REPOSITORY_LOCAL_PAGE_SIZE) {
    this.repos = repos;
    this.pageSize = pageSize;
    this.page = 1;
  }

  /** Total number of repositories in this collection (unaffected by pagination). */
  get length(): number {
    return this.repos.length;
  }

  /** Repositories visible up to and including the current page. */
  get visible(): DopRepository[] {
    return this.repos.slice(0, this.page * this.pageSize);
  }

  /** True when there are more repositories beyond the current visible window. */
  get hasMore(): boolean {
    return this.page * this.pageSize < this.repos.length;
  }

  /** Advance the visible window by one page. */
  loadMore(): void {
    if (this.hasMore) this.page++;
  }
}
