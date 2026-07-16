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

export interface PooledResult<TItem, TValue> {
  item: TItem;
  status: 'fulfilled' | 'rejected';
  value?: TValue;
  reason?: unknown;
}

/**
 * Runs `task` over `items` with at most `limit` concurrently in flight. Never rejects: each
 * item's outcome is captured individually (`Promise.allSettled`-style), so one item's failure
 * never aborts or blocks the others. Results are returned in the same order as `items`.
 */
export async function runWithConcurrencyLimit<TItem, TValue>(
  items: TItem[],
  limit: number,
  task: (item: TItem, index: number) => Promise<TValue>,
): Promise<PooledResult<TItem, TValue>[]> {
  const results = new Array<PooledResult<TItem, TValue>>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index];
      try {
        const value = await task(item, index);
        results[index] = { item, status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { item, status: 'rejected', reason };
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
