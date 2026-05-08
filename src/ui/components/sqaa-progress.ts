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

// Live progress display for the SQAA worker-pool run.

import * as readline from 'node:readline';

import { bold, cyan, dim, green, red, yellow } from '../colors.js';
import { isMockActive, recordCall } from '../mock.js';

export type FileStatus =
  | 'waiting'
  | 'analyzing'
  | 'done'
  | 'failed'
  | 'retrying'
  | 'skipped'
  | 'ignored';

const BAR_WIDTH = 12;
const FILLED = '⣿';
const EMPTY = '⣀';
/** Interval for the live countdown tick in milliseconds. */
const COUNTDOWN_TICK_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderBar(done: number, total: number): string {
  const filled = total === 0 ? BAR_WIDTH : Math.round((done / total) * BAR_WIDTH);
  return '[' + FILLED.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled) + ']';
}

function statusLabel(status: FileStatus, retryLabel?: string): string {
  switch (status) {
    case 'waiting':
      return dim('[WAITING]');
    case 'analyzing':
      return cyan('[ANALYZING...]');
    case 'done':
      return green('[DONE]');
    case 'failed':
      return red('[FAILED]');
    case 'retrying':
      return yellow(retryLabel ?? '[RETRYING...]');
    case 'skipped':
      return dim('[SKIPPED]');
    case 'ignored':
      return dim('[IGNORED]');
  }
}

function statusIcon(status: FileStatus): string {
  if (status === 'waiting') return dim('○');
  if (status === 'skipped' || status === 'ignored') return dim('⊘');
  return '●';
}

/** Icon used in non-TTY per-file result lines (rolling output and finish()). */
function fileStatusIcon(status: FileStatus): string {
  if (status === 'done') return green('✓');
  if (status === 'failed') return red('✗');
  if (status === 'skipped' || status === 'ignored') return dim('⊘');
  return dim('○');
}

/** Render a single file row with padding to align the status label column. */
function formatFileLine(path: string, icon: string, label: string, colWidth: number): string {
  const padding = ' '.repeat(Math.max(1, colWidth - path.length));
  return `  ${icon} ${path}${padding}${label}`;
}

/**
 * Single progress renderer for an entire SQAA worker-pool run.
 *
 * Initialized with all file paths upfront; all files are visible throughout the run.
 *
 * TTY: maintains one block on screen — erases and rewrites it in-place on every update.
 * Non-TTY: prints a one-time `Analyzing <N> files...` header on `start()`, then a
 *          per-file result line every time a file reaches a terminal status
 *          (`done`/`failed`) — i.e. rolling output in completion order.
 */
export class SqaaProgress {
  private readonly allFiles: string[];
  private readonly statuses: FileStatus[];
  private readonly isTTY: boolean;
  /** When true, all rendering methods are no-ops (used by --format json). */
  private readonly silent: boolean;
  /**
   * Number of files the worker pool will actually analyze — i.e. `allFiles`
   * minus pre-ignored entries. Used as the denominator of the progress bar and
   * the `X/Y files analyzed` summary so 100% is reachable when ignored files
   * are present.
   */
  private readonly processableTotal: number;
  /** Width of the path column — longest path length + 1 space minimum. */
  private readonly colWidth: number;
  /** Per-file dynamic label override (used for retry countdown). */
  private readonly retryLabels = new Map<number, string>();
  /** Number of lines currently written to stdout (TTY mode only). */
  private linesRendered = 0;

  constructor(opts: {
    files: string[];
    ignoredFiles?: string[];
    isTTY?: boolean;
    silent?: boolean;
  }) {
    const ignored = opts.ignoredFiles ?? [];
    this.allFiles = [...opts.files, ...ignored];
    const waiting: FileStatus = 'waiting';
    const ignoredStatus: FileStatus = 'ignored';
    this.statuses = [...opts.files.map(() => waiting), ...ignored.map(() => ignoredStatus)];
    this.isTTY = opts.isTTY ?? process.stdout.isTTY;
    this.silent = opts.silent ?? false;
    this.processableTotal = opts.files.length;
    this.colWidth = Math.max(...this.allFiles.map((f) => f.length), 0) + 2;
  }

  /**
   * Render the initial state of the progress block. Call this once before the
   * worker pool spawns; subsequent transitions arrive via `update()`.
   * TTY: draws the full block.
   * Non-TTY: prints a one-time `Analyzing <N> files...` header.
   */
  start(): void {
    if (this.silent) return;
    if (isMockActive()) {
      recordCall('sqaaProgress.start');
      return;
    }
    if (this.isTTY) {
      this.eraseTTY();
      this.renderTTY();
    } else {
      // Files counted are the ones the pool will process — exclude files already
      // marked as ignored (binary/oversized) at construction time.
      process.stdout.write(`\nAnalyzing ${this.processableTotal} files...\n`);
    }
  }

  /**
   * Update a file's status by its global index across all files.
   * TTY: redraws the full block.
   * Non-TTY: prints a per-file result line on terminal transitions
   *          (`done`/`failed`); other transitions are absorbed silently.
   */
  update(globalIndex: number, status: FileStatus): void {
    if (this.silent) {
      this.statuses[globalIndex] = status;
      return;
    }
    if (isMockActive()) {
      recordCall('sqaaProgress.update', globalIndex, status);
      return;
    }
    this.statuses[globalIndex] = status;
    if (this.isTTY) {
      this.eraseTTY();
      this.renderTTY();
      return;
    }
    if (status === 'done' || status === 'failed') {
      process.stdout.write(`  ${fileStatusIcon(status)}  ${this.allFiles[globalIndex]}\n`);
    }
  }

  /**
   * Show a retry countdown for a file, waiting delayMs before resolving.
   * Resets the file's status back to 'analyzing' when done so the caller
   * can transition it without a stale [RETRYING...] flash.
   * TTY: updates the file's label in the progress block each second.
   * Non-TTY: prints a single static line then waits.
   */
  async retrying(
    globalIndex: number,
    attempt: number,
    maxRetries: number,
    delayMs: number,
  ): Promise<void> {
    if (this.silent) {
      // Still wait so retry semantics are preserved without rendering.
      this.statuses[globalIndex] = 'retrying';
      await sleep(delayMs);
      this.statuses[globalIndex] = 'analyzing';
      return;
    }
    if (isMockActive()) {
      recordCall('sqaaProgress.retrying', globalIndex, attempt, maxRetries, delayMs);
      return;
    }
    const totalSeconds = Math.round(delayMs / COUNTDOWN_TICK_MS);
    this.statuses[globalIndex] = 'retrying';

    if (!this.isTTY) {
      process.stdout.write(
        `⚠️  Server busy (503). Retrying in ${totalSeconds}s... [Attempt ${attempt}/${maxRetries}]\n`,
      );
      await sleep(delayMs);
      this.statuses[globalIndex] = 'analyzing';
      return;
    }

    for (let remaining = totalSeconds; remaining > 0; remaining--) {
      this.retryLabels.set(globalIndex, `[RETRYING in ${remaining}s... ${attempt}/${maxRetries}]`);
      this.eraseTTY();
      this.renderTTY();
      await sleep(COUNTDOWN_TICK_MS);
    }
    this.retryLabels.delete(globalIndex);
    // Reset status here so no intervening redraw shows the stale [RETRYING...] fallback.
    this.statuses[globalIndex] = 'analyzing';
  }

  /**
   * Mark all files from fromIndex onwards as skipped.
   * Call before finish() when fail-fast stops processing early.
   */
  skipRemaining(fromIndex: number): void {
    if (this.silent) {
      // Still record skips in internal state so callers can read them.
      for (let i = fromIndex; i < this.allFiles.length; i++) {
        if (this.statuses[i] === 'waiting') {
          this.statuses[i] = 'skipped';
        }
      }
      return;
    }
    if (isMockActive()) {
      recordCall('sqaaProgress.skipRemaining', fromIndex);
      return;
    }
    for (let i = fromIndex; i < this.allFiles.length; i++) {
      if (this.statuses[i] === 'waiting') {
        this.statuses[i] = 'skipped';
      }
    }
  }

  /**
   * Read-only access to file statuses by global index.
   * Exposed for testing and introspection (e.g. verifying silent-mode state transitions).
   */
  getStatuses(): readonly FileStatus[] {
    return this.statuses;
  }

  /**
   * Called once after the worker pool has joined (success or fail-fast).
   * TTY: erases the live block, reprints the summary bar first, then the file list with
   *      final statuses — so the bar stays at the top and the list persists on screen.
   * Non-TTY: prints any skipped files that were never reached (fail-fast path);
   *          non-skipped files were already printed in rolling order by `update()`.
   */
  finish(processedTotal: number): void {
    if (this.silent) return;
    if (isMockActive()) {
      recordCall('sqaaProgress.finish', processedTotal);
      return;
    }
    if (this.isTTY) {
      this.eraseTTY();
      const bar = renderBar(processedTotal, this.processableTotal);
      process.stdout.write(`${bar} ${processedTotal}/${this.processableTotal} files analyzed\n\n`);
      for (let i = 0; i < this.allFiles.length; i++) {
        process.stdout.write(
          formatFileLine(
            this.allFiles[i],
            statusIcon(this.statuses[i]),
            statusLabel(this.statuses[i]),
            this.colWidth,
          ) + '\n',
        );
      }
      process.stdout.write('\n');
      this.linesRendered = 0;
    } else {
      // Print skipped files that the rolling per-file output never reached
      // (fail-fast path — these files were never picked up by a worker).
      for (let i = 0; i < this.allFiles.length; i++) {
        if (this.statuses[i] === 'skipped') {
          process.stdout.write(`  ${fileStatusIcon('skipped')}  ${this.allFiles[i]}\n`);
        }
      }
    }
  }

  private buildLines(): string[] {
    const done = this.statuses.filter((s) => s === 'done' || s === 'failed').length;
    const bar = renderBar(done, this.processableTotal);
    const lines: string[] = [
      bold('SonarQube Agentic Analysis in progress...'),
      `${bar} ${done}/${this.processableTotal} files analyzed`,
      '',
    ];
    for (let i = 0; i < this.allFiles.length; i++) {
      lines.push(
        formatFileLine(
          this.allFiles[i],
          statusIcon(this.statuses[i]),
          statusLabel(this.statuses[i], this.retryLabels.get(i)),
          this.colWidth,
        ),
      );
    }
    return lines;
  }

  private renderTTY(): void {
    const lines = this.buildLines();
    for (const line of lines) {
      process.stdout.write(line + '\n');
    }
    this.linesRendered = lines.length;
  }

  private eraseTTY(): void {
    // Cap lines to erase at the current terminal height to avoid moving the cursor
    // past the top of the viewport if the block scrolled out of view.
    // Cap to terminal height when known, to avoid moving the cursor above the viewport.
    const rows: number | undefined = process.stdout.rows;
    const linesToErase = rows ? Math.min(this.linesRendered, rows - 1) : this.linesRendered;
    for (let i = 0; i < linesToErase; i++) {
      readline.moveCursor(process.stdout, 0, -1);
      readline.clearLine(process.stdout, 0);
    }
    this.linesRendered = 0;
  }
}
