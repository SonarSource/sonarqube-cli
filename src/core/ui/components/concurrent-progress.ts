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

// Generic live progress display for concurrent operations.

import * as readline from 'node:readline';

import { bold, dim, green, red, STATUS_COLORS, STATUS_ICONS, visibleLength } from '../colors.ts';
import { isMockActive, recordCall } from '../mock.ts';
import { phase, phaseItem } from './phase.ts';

export type ConcurrentItemStatus = 'pending' | 'running' | 'done' | 'failed';

const BAR_WIDTH = 24;
const BAR_FILLED = '█';
const BAR_EMPTY = '░';
const DEFAULT_MAX_VISIBLE = 10;

interface ItemState {
  status: ConcurrentItemStatus;
  detail?: string;
  ref?: string;
}

function toPhaseStatus(status: ConcurrentItemStatus | undefined): 'done' | 'failed' | 'skipped' {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  return 'skipped';
}

/**
 * Live progress renderer for concurrent operations: one row per item (status icon, label, colored
 * detail) plus a progress bar, redrawn in place as `update()` is called. TTY-only — non-TTY falls
 * back to the static `phase()` component, so CI/piped output is unaffected.
 *
 * Shows at most `maxVisible` rows at once — mirroring the concurrency cap. As a visible item
 * finishes (done/failed), if there's a queued item waiting it takes over that same row.
 */
export class ConcurrentProgress {
  private readonly order: string[] = [];
  private readonly items = new Map<string, ItemState>();
  protected readonly isTTY: boolean;
  private readonly visible: string[] = [];
  private readonly queue: string[] = [];
  private readonly maxVisible: number;
  private readonly showResult: boolean;
  private readonly resultTitle: string;
  protected readonly mockPrefix: string;
  private total = 0;
  protected skippedResolved = 0;
  private linesRendered = 0;

  constructor(opts: {
    isTTY?: boolean;
    maxVisible?: number;
    showResult?: boolean;
    resultTitle?: string;
    mockPrefix?: string;
  }) {
    this.isTTY = opts.isTTY ?? process.stdout.isTTY;
    this.maxVisible = opts.maxVisible ?? DEFAULT_MAX_VISIBLE;
    this.showResult = opts.showResult ?? true;
    this.resultTitle = opts.resultTitle ?? 'Results';
    this.mockPrefix = opts.mockPrefix ?? 'concurrentProgress';
  }

  setTotal(total: number): void {
    this.total = total;
  }

  protected registerItems(slugs: string[]): void {
    for (const slug of slugs) {
      this.items.set(slug, { status: 'pending' });
      this.order.push(slug);
      this.admit(slug);
    }
  }

  addItems(slugs: string[]): void {
    this.registerItems(slugs);
    if (isMockActive()) {
      recordCall(`${this.mockPrefix}.addItems`, slugs);
      return;
    }
    if (this.isTTY) this.render();
  }

  start(): void {
    if (isMockActive()) {
      recordCall(`${this.mockPrefix}.start`);
      return;
    }
    if (this.isTTY) this.render();
  }

  update(slug: string, status: ConcurrentItemStatus, detail?: string, ref?: string): void {
    this.items.set(slug, { status, detail, ref });
    if (status === 'done' || status === 'failed') this.promoteNext(slug);
    if (isMockActive()) {
      recordCall(`${this.mockPrefix}.update`, slug, status, detail, ref);
      return;
    }
    if (this.isTTY) this.render();
  }

  finish(): { succeeded: number; failed: number } {
    const states = [...this.items.values()];
    const succeeded = states.filter((s) => s.status === 'done').length;
    const failed = states.filter((s) => s.status === 'failed').length;

    if (isMockActive()) {
      recordCall(`${this.mockPrefix}.finish`);
      return { succeeded, failed };
    }

    if (this.isTTY) {
      this.render();
      if (this.showResult) this.printResult(succeeded, failed);
    } else {
      const phaseItems = this.order.map((slug) => {
        const state = this.items.get(slug);
        return phaseItem(slug, toPhaseStatus(state?.status), state?.detail);
      });
      phase(this.resultTitle, phaseItems);
    }

    return { succeeded, failed };
  }

  private promoteNext(finishedSlug: string): void {
    const slot = this.visible.indexOf(finishedSlug);
    if (slot === -1) return;
    const next = this.queue.shift();
    if (next !== undefined) this.visible[slot] = next;
  }

  private admit(slug: string): void {
    if (this.visible.length < this.maxVisible) {
      this.visible.push(slug);
      return;
    }
    const staleSlot = this.visible.findIndex((s) => this.isTerminal(s));
    if (staleSlot !== -1) {
      this.visible[staleSlot] = slug;
      return;
    }
    this.queue.push(slug);
  }

  private isTerminal(slug: string): boolean {
    const status = this.items.get(slug)?.status;
    return status === 'done' || status === 'failed';
  }

  private printResult(succeeded: number, failed: number): void {
    process.stdout.write(`\n  ${bold(this.resultTitle)}\n`);
    process.stdout.write(`    ${green('✓')}  Succeeded: ${succeeded}\n`);
    process.stdout.write(`    ${red('✗')}  Failed: ${failed}\n`);
  }

  protected render(): void {
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
    const maxLabelWidth =
      this.order.length === 0 ? 0 : Math.max(...this.order.map((s) => visibleLength(s)));
    const rows = this.visible.map((slug) => this.formatRow(slug, maxLabelWidth));
    return [...rows, '', this.formatBar()];
  }

  protected formatLabel(slug: string): string {
    return bold(slug);
  }

  private formatRow(slug: string, labelWidth: number): string {
    const state = this.items.get(slug) ?? { status: 'pending' as const };
    const { status } = state;
    const icon = STATUS_ICONS[status];
    const iconColor = STATUS_COLORS[status];

    const label = this.formatLabel(slug);
    const padding = ' '.repeat(Math.max(0, labelWidth - visibleLength(slug)));

    const detail = state.detail ? STATUS_COLORS[status](state.detail) : '';
    const ref = state.ref ? dim(state.ref) : '';

    return `    ${iconColor(icon)}  ${label}${padding}  ${detail}  ${ref}`.trimEnd();
  }

  private formatBar(): string {
    const resolved =
      [...this.items.values()].filter((s) => s.status === 'done' || s.status === 'failed').length +
      this.skippedResolved;
    const pct = this.total === 0 ? 100 : Math.min(100, Math.round((resolved / this.total) * 100));
    const filled = Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH));
    const bar = green(BAR_FILLED.repeat(filled)) + dim(BAR_EMPTY.repeat(BAR_WIDTH - filled));
    const pctLabel = bold(`${pct}%`);
    const fractionLabel = dim(`${resolved}/${this.total}`);
    return `    ${bar}  ${pctLabel} ${fractionLabel}`;
  }
}
