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

import type { CiConfigurationRun, CiRunCounts } from '@/core/server/ci-configuration.ts';
import { ConcurrentProgress } from '@/core/ui/components/concurrent-progress.ts';
import type { Console } from '@/core/ui/console.ts';

const RUN_ROW = 'Server-side run';

export function formatRunCounts(counts: CiRunCounts, dryRun: boolean): string {
  const outcome = dryRun
    ? `${counts.wouldOpen.toLocaleString()} would open`
    : `${counts.opened.toLocaleString()} opened`;
  return `${outcome} · ${counts.skipped.toLocaleString()} skipped · ${counts.failed.toLocaleString()} failed · ${counts.running.toLocaleString()} in progress · ${counts.queued.toLocaleString()} queued`;
}

/**
 * One updatable row plus a progress bar for a run whose repositories are only known to the
 * server. On a non-TTY it prints a line whenever the counts change instead of redrawing.
 */
export class RunProgress extends ConcurrentProgress {
  private readonly output: Console;
  private lastDetail = '';

  constructor(output: Console) {
    super({ console: output, maxVisible: 1, showResult: false, resultTitle: 'CI configuration' });
    this.output = output;
  }

  begin(): void {
    this.addItems([RUN_ROW]);
    this.start();
  }

  report(run: CiConfigurationRun): void {
    const { counts } = run;
    const detail = formatRunCounts(counts, run.dryRun);
    this.setTotal(counts.total);
    this.skippedResolved = Math.max(0, counts.total - counts.queued - counts.running);
    this.update(RUN_ROW, 'running', detail);
    if (!this.isTTY && detail !== this.lastDetail) {
      this.output.info(detail);
    }
    this.lastDetail = detail;
  }

  complete(run: CiConfigurationRun): void {
    const failed = run.status === 'FAILED';
    // The row itself counts as one resolved item once done; keep the bar at exactly 100%.
    this.skippedResolved = Math.max(0, run.counts.total - 1);
    this.update(RUN_ROW, failed ? 'failed' : 'done', formatRunCounts(run.counts, run.dryRun));
    this.finish();
  }
}
