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

import { describe, expect, it } from 'bun:test';

import { RepositoryCollection } from '../../../../../../src/cli/commands/import/_common/repository-collection.ts';
import type { DopRepository } from '../../../../../../src/sonarqube/client.ts';
import { SonarQubeClient } from '../../../../../../src/sonarqube/client.ts';

const ONLY_PRIVATE_PROJECTS = { enabled: false, available: false };

function makeRepos(count: number, prefix: string): DopRepository[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: `${prefix}-${i}`,
    slug: `${prefix}-${i}`,
    private: false,
    archived: false,
    boundProjectIds: [],
    importedInCurrentOrg: false,
  }));
}

describe('RepositoryCollection.loadMore', () => {
  it('retries a failed page fetch on the next call instead of treating the collection as exhausted', async () => {
    const firstPage = makeRepos(SonarQubeClient.DOP_REPOSITORIES_MAX_PAGE_SIZE, 'page1');
    const secondPage = makeRepos(1, 'page2');
    const callsPerPage = new Map<number, number>();

    const fetchPage = (
      pageIndex: number,
      _pageSize: number,
    ): Promise<{ repositories: DopRepository[]; total: number }> => {
      callsPerPage.set(pageIndex, (callsPerPage.get(pageIndex) ?? 0) + 1);

      if (pageIndex === 2 && callsPerPage.get(pageIndex) === 1) {
        return Promise.reject(new Error('transient network error'));
      }

      const repositories = pageIndex === 1 ? firstPage : secondPage;
      return Promise.resolve({ repositories, total: firstPage.length + secondPage.length });
    };

    const collection = await RepositoryCollection.create(fetchPage, ONLY_PRIVATE_PROJECTS);
    expect(collection.eligibleRepos).toHaveLength(firstPage.length);
    expect(collection.hasMore).toBe(true);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(collection.loadMore()).rejects.toThrow('transient network error');
    // The failed attempt must not consume the page or mark the collection exhausted.
    expect(collection.hasMore).toBe(true);
    expect(collection.eligibleRepos).toHaveLength(firstPage.length);

    const retryResult = await collection.loadMore();
    expect(retryResult.eligible.map((r) => r.slug)).toEqual(secondPage.map((r) => r.slug));
    expect(collection.eligibleRepos).toHaveLength(firstPage.length + secondPage.length);
    expect(collection.hasMore).toBe(false);
    expect(callsPerPage.get(2)).toBe(2);
  });
});
