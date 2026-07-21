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

import type { Organization } from '../../../sonarqube/client.ts';

const ORGANIZATION_LOCAL_PAGE_SIZE = 10;

/** Filters and locally paginates organizations for the `sonar import` select prompt. */
export class OrganizationCollection {
  private readonly orgs: Organization[];
  private readonly pageSize: number;
  private page: number;

  constructor(orgs: Organization[], pageSize = ORGANIZATION_LOCAL_PAGE_SIZE) {
    this.orgs = orgs;
    this.pageSize = pageSize;
    this.page = 1;
  }

  /** Total number of organizations in this collection (unaffected by pagination). */
  get length(): number {
    return this.orgs.length;
  }

  /** Organizations visible up to and including the current page. */
  get visible(): Organization[] {
    return this.orgs.slice(0, this.page * this.pageSize);
  }

  /** True when there are more organizations beyond the current visible window. */
  get hasMore(): boolean {
    return this.page * this.pageSize < this.orgs.length;
  }

  /** Advance the visible window by one page. */
  loadMore(): void {
    if (this.hasMore) this.page++;
  }

  /** Return a new collection containing only orgs where the user is an admin. */
  withAdmin(): OrganizationCollection {
    return new OrganizationCollection(
      this.orgs.filter((o) => o.actions?.admin === true),
      this.pageSize,
    );
  }

  /** Return a new collection containing only orgs that have a DevOps platform bound. */
  withAlm(): OrganizationCollection {
    return new OrganizationCollection(
      this.orgs.filter((o) => o.alm !== undefined),
      this.pageSize,
    );
  }
}
