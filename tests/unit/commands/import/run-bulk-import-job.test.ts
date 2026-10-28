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

import { describe, expect, it, spyOn } from 'bun:test';

import type { DopRepository } from '@/commands/import/import-api.ts';
import { ImportApiClient } from '@/commands/import/import-api.ts';
import type { ImportPlan } from '@/commands/import/import-backend.ts';
import { runBulkImportJob } from '@/commands/import/index.ts';
import { RepositoryCollection } from '@/commands/import/repository-collection.ts';
import { ConcurrentProgress } from '@/core/ui/components/concurrent-progress.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const PAGE_SIZE = ImportApiClient.DOP_REPOSITORIES_MAX_PAGE_SIZE;

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

describe('runBulkImportJob', () => {
  it('refreshes the progress total after every page, so a total that grows page by page is tracked', async () => {
    const setTotal = spyOn(ConcurrentProgress.prototype, 'setTotal');
    const pageSizes = [PAGE_SIZE, PAGE_SIZE, 20];
    const fetchPage = (pageIndex: number) => {
      const repositories = makeRepos(pageSizes[pageIndex - 1], `p${pageIndex}`);
      const total = pageSizes.slice(0, pageIndex).reduce((sum, size) => sum + size, 0);
      return Promise.resolve({ repositories, total });
    };
    const collection = await RepositoryCollection.create(fetchPage, {
      enabled: false,
      available: false,
    });
    const plan = {
      toResolvedRepo: (repo: DopRepository) => ({ slug: repo.slug }),
      importRepo: () => Promise.resolve({}),
    } as unknown as ImportPlan;

    try {
      const result = await runBulkImportJob(plan, collection, undefined, new FakeConsole());

      expect(setTotal.mock.calls.map(([total]) => total)).toEqual([
        PAGE_SIZE,
        2 * PAGE_SIZE,
        2 * PAGE_SIZE + 20,
      ]);
      expect(result.succeeded).toBe(2 * PAGE_SIZE + 20);
    } finally {
      setTotal.mockRestore();
    }
  });
});
