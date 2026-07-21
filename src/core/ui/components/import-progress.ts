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

import * as readline from 'node:readline';

import { bold, dim, green, red, STATUS_COLORS, STATUS_ICONS, visibleLength } from '../colors.ts';
import { isMockActive, recordCall } from '../mock.ts';
import { phase, phaseItem } from './phase.ts';

/** Subset of `StepStatus` relevant to a repo's provisioning lifecycle. */
export type ImportRepoStatus = 'pending' | 'running' | 'done' | 'failed';

const BAR_WIDTH = 24;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';
const DEFAULT_MAX_VISIBLE = 10;

interface RepoState {
  status: ImportRepoStatus;
  detail?: string;
  ref?: string;
}

/** Maps a repo's live status to the static `phase()` component's non-TTY-fallback vocabulary. */
function toPhaseStatus(status: ImportRepoStatus | undefined): 'done' | 'failed' | 'skipped' {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  return 'skipped';
}

/**
 * Live progress renderer for `sonar import`'s concurrent provisioning phase: one row per repo
 * (status icon, slug, colored detail, dim reference) plus a progress bar, redrawn in place as
 * `update()` is called. TTY-only — non-TTY output (including every integration test, which runs
 * the binary through a piped process) falls back to the existing static `phase()` component, so
 * CI/piped output is unaffected by this purely interactive enhancement.
 *
 * Shows at most `maxVisible` rows at once — mirroring the provisioning concurrency cap, since
 * showing every repo (possibly far more than can ever be in flight at once) as idle 'pending'
 * rows isn't useful. As a visible repo finishes (done/failed), if there's a queued repo waiting
 * to start it takes over that same row; otherwise the finished row is left as-is, showing its
 * done/failed state (this is the common case: batches no larger than `maxVisible` never have a
 * queue at all, so every repo simply stays visible throughout).
 */
export class ImportProgress {
  private readonly order: string[] = [];
  private readonly repos = new Map<string, RepoState>();
  private readonly isTTY: boolean;
  private readonly visible: string[] = [];
  private readonly queue: string[] = [];
  private readonly maxVisible: number;
  private total = 0;
  private skippedResolved = 0;
  private linesRendered = 0;

  constructor(opts: { isTTY?: boolean; maxVisible?: number }) {
    this.isTTY = opts.isTTY ?? process.stdout.isTTY;
    this.maxVisible = opts.maxVisible ?? DEFAULT_MAX_VISIBLE;
  }

  /** Sets the progress bar's denominator. Call once, before `start()`. */
  setTotal(total: number): void {
    this.total = total;
  }

  /** Registers newly discovered repos to track/render, appending to the visible or queued set. */
  addRepos(slugs: string[]): void {
    for (const slug of slugs) {
      this.repos.set(slug, { status: 'pending' });
      this.order.push(slug);
      this.admit(slug);
    }
    if (isMockActive()) {
      recordCall('importProgress.addRepos', slugs);
      return;
    }
    if (this.isTTY) {
      this.render();
    }
  }

  /**
   * Advances the progress bar for repos resolved without a provisioning call (e.g. already
   * imported) — no row is added for them, they only count toward the bar's resolved fraction, or
   * a streaming job's bar could never reach 100% while skipped repos keep turning up.
   */
  recordSkipped(count: number): void {
    if (count <= 0) return;
    this.skippedResolved += count;
    if (isMockActive()) {
      recordCall('importProgress.recordSkipped', count);
      return;
    }
    if (this.isTTY) {
      this.render();
    }
  }

  start(): void {
    if (isMockActive()) {
      recordCall('importProgress.start');
      return;
    }
    if (this.isTTY) {
      this.render();
    }
  }

  update(slug: string, status: ImportRepoStatus, detail?: string, ref?: string): void {
    this.repos.set(slug, { status, detail, ref });
    if (status === 'done' || status === 'failed') {
      this.promoteNext(slug);
    }
    if (isMockActive()) {
      recordCall('importProgress.update', slug, status, detail, ref);
      return;
    }
    if (this.isTTY) {
      this.render();
    }
  }

  /** On a visible repo's completion, swap in the next queued repo to the same row, if any. */
  private promoteNext(finishedSlug: string): void {
    const slot = this.visible.indexOf(finishedSlug);
    if (slot === -1) return;
    const next = this.queue.shift();
    if (next !== undefined) {
      this.visible[slot] = next;
    }
  }

  /**
   * Places a newly discovered repo into the first available row: an empty slot if `visible`
   * hasn't filled up yet, otherwise a slot already showing a finished (done/failed) repo from an
   * earlier batch — that row's own completion already fired `promoteNext`, so nothing will ever
   * swap it out again on its own. Falls back to the queue only when every visible slot is still
   * pending/running, to be promoted later via `promoteNext`.
   */
  private admit(slug: string): void {
    if (this.visible.length < this.maxVisible) {
      this.visible.push(slug);
      return;
    }
    const staleSlot = this.visible.findIndex((visibleSlug) => this.isTerminal(visibleSlug));
    if (staleSlot !== -1) {
      this.visible[staleSlot] = slug;
      return;
    }
    this.queue.push(slug);
  }

  private isTerminal(slug: string): boolean {
    const status = this.repos.get(slug)?.status;
    return status === 'done' || status === 'failed';
  }

  /** Finalizes the display and returns aggregate counts. */
  finish(): { succeeded: number; failed: number } {
    const states = [...this.repos.values()];
    const succeeded = states.filter((s) => s.status === 'done').length;
    const failed = states.filter((s) => s.status === 'failed').length;

    if (isMockActive()) {
      recordCall('importProgress.finish');
      return { succeeded, failed };
    }

    if (this.isTTY) {
      this.render();
      this.printResult(succeeded, failed);
    } else {
      const items = this.order.map((slug) => {
        const state = this.repos.get(slug);
        return phaseItem(slug, toPhaseStatus(state?.status), state?.detail);
      });
      phase('Import results', items);
    }

    return { succeeded, failed };
  }

  private printResult(succeeded: number, failed: number): void {
    process.stdout.write(`\n  ${bold('Result')}\n`);
    process.stdout.write(`    ${green('✓')}  Succeeded: ${succeeded}\n`);
    process.stdout.write(`    ${red('✗')}  Failed: ${failed}\n`);
  }

  private render(): void {
    this.erase();
    const lines = this.buildLines();
    process.stdout.write(lines.join('\n') + '\n');
    this.linesRendered = lines.length;
  }

  private erase(): void {
    if (this.linesRendered === 0) return;
    readline.moveCursor(process.stdout, 0, -this.linesRendered);
    readline.cursorTo(process.stdout, 0);
    readline.clearScreenDown(process.stdout);
    this.linesRendered = 0;
  }

  private buildLines(): string[] {
    // Computed from every repo (not just the currently visible ones) so column alignment
    // stays stable as rows are swapped out — otherwise the bar/label columns would jitter
    // depending on which slugs happen to be in the window at a given moment.
    const maxLabelWidth =
      this.order.length === 0 ? 0 : Math.max(...this.order.map((slug) => visibleLength(slug)));
    const rows = this.visible.map((slug) => this.formatRow(slug, maxLabelWidth));
    return [...rows, '', this.formatBar()];
  }

  private formatRow(slug: string, labelWidth: number): string {
    const state = this.repos.get(slug) ?? { status: 'pending' as const };
    const status: 'pending' | 'running' | 'done' | 'failed' = state.status;
    const icon = STATUS_ICONS[status];
    const iconColor = STATUS_COLORS[status];

    const slashIndex = slug.indexOf('/');
    const org = slashIndex === -1 ? '' : slug.slice(0, slashIndex + 1);
    const name = slashIndex === -1 ? slug : slug.slice(slashIndex + 1);
    const label = `${dim(org)}${bold(name)}`;
    const padding = ' '.repeat(Math.max(0, labelWidth - visibleLength(slug)));

    const detail = state.detail ? STATUS_COLORS[status](state.detail) : '';
    const ref = state.ref ? dim(state.ref) : '';

    return `    ${iconColor(icon)}  ${label}${padding}  ${detail}  ${ref}`.trimEnd();
  }

  private formatBar(): string {
    const total = this.total;
    const resolved =
      [...this.repos.values()].filter((s) => s.status === 'done' || s.status === 'failed').length +
      this.skippedResolved;
    // Clamped because `total` is the server-reported count, which loop termination
    // deliberately distrusts (see `iterateRepoPages`) and so can be stale/inconsistent with
    // the number of repos actually resolved.
    const pct = total === 0 ? 100 : Math.min(100, Math.round((resolved / total) * 100));
    const filled = Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH));
    const bar = green(BAR_FILLED.repeat(filled)) + dim(BAR_EMPTY.repeat(BAR_WIDTH - filled));
    const pctLabel = bold(`${pct}%`);
    const fractionLabel = dim(`${resolved}/${total}`);

    return `    ${bar}  ${pctLabel} ${fractionLabel}`;
  }
}
