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

// Live progress display for `sonar import` provisioning.

import { bold, dim } from '@/core/ui/colors.ts';
import { ConcurrentProgress } from '@/core/ui/components/concurrent-progress.ts';
import { isMockActive, recordCall } from '@/core/ui/mock.ts';

/**
 * Extends `ConcurrentProgress` with import-specific additions:
 * - `addRepos()` as a domain alias for `addItems()`
 * - `recordSkipped()` for repos resolved without a provisioning call (streaming/paginated imports)
 * - `formatLabel()` dims the `org/` prefix so the repo name stands out
 */
export class ImportProgress extends ConcurrentProgress {
  constructor(opts: { isTTY?: boolean; maxVisible?: number; showResult?: boolean }) {
    super({ ...opts, resultTitle: 'Import results', mockPrefix: 'importProgress' });
  }

  protected override formatLabel(slug: string): string {
    const slashIndex = slug.indexOf('/');
    if (slashIndex === -1) return bold(slug);
    return `${dim(slug.slice(0, slashIndex + 1))}${bold(slug.slice(slashIndex + 1))}`;
  }

  addRepos(slugs: string[]): void {
    this.registerItems(slugs);
    if (isMockActive()) {
      recordCall('importProgress.addRepos', slugs);
      return;
    }
    if (this.isTTY) this.render();
  }

  /**
   * Advances the progress bar for repos resolved without a provisioning call (e.g. already
   * imported) — no row is added for them, they only count toward the bar's resolved fraction.
   */
  recordSkipped(count: number): void {
    if (count <= 0) return;
    this.skippedResolved += count;
    if (isMockActive()) {
      recordCall('importProgress.recordSkipped', count);
      return;
    }
    if (this.isTTY) this.render();
  }
}
