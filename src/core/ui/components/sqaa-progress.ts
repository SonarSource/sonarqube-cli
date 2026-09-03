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

// Live progress display for SQAA change-set analysis.

import * as readline from 'node:readline';

import { cyan, yellow } from '../colors.ts';
import { warn } from '../messages.ts';

export type FileStatus = 'waiting' | 'analyzing' | 'done' | 'failed' | 'skipped' | 'ignored';

type RunPhase = 'idle' | 'analyzing' | 'retrying';

const COUNTDOWN_TICK_MS = 1000;
const DOT_ANIMATION_MS = 450;
const DOT_FRAMES = ['.', '..', '...'] as const;

const PAYLOAD_SPLIT_WARNING =
  'Request size limit reached; analysis was split into smaller batches. Cross-file context may be reduced.';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Progress renderer for an SQAA change-set run.
 *
 * During the run: one live status line. On `finish()`: erases the live line only;
 * final file list and issues are rendered by sqaa-display.
 */
export class SqaaProgress {
  private readonly allFiles: string[];
  private readonly statuses: FileStatus[];
  private readonly isTTY: boolean;
  private readonly silent: boolean;
  private readonly processableTotal: number;
  private liveLineRendered = false;

  private runPhase: RunPhase = 'idle';
  private retryLabel?: string;
  private payloadSplitWarned = false;
  private dotFrameIndex = 0;
  private dotAnimationTimer?: ReturnType<typeof setInterval>;

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
  }

  start(): void {
    if (this.silent) return;
    if (this.isTTY) {
      this.startDotAnimation();
      this.renderLiveLine();
    }
  }

  /** Warn once when a 413 response forces runtime request splitting. */
  warnPayloadSplit(): void {
    if (this.payloadSplitWarned) return;
    this.payloadSplitWarned = true;
    if (this.silent) return;
    // Erase the live line first so the warning is not overwritten by the
    // next animation tick; the live line is re-rendered fresh below it.
    if (this.isTTY) {
      this.eraseLiveLine();
    }
    warn(PAYLOAD_SPLIT_WARNING);
  }

  updateChunk(_chunkIndex: number, status: Exclude<FileStatus, 'ignored'>): void {
    if (status === 'analyzing') {
      this.runPhase = 'analyzing';
    } else if (status === 'done' || status === 'failed') {
      this.runPhase = 'idle';
      this.retryLabel = undefined;
    }
    if (this.silent) return;
    if (this.isTTY) {
      this.renderLiveLine();
    }
  }

  update(globalIndex: number, status: FileStatus): void {
    this.statuses[globalIndex] = status;
    if (this.silent) return;
    if (this.isTTY) {
      this.renderLiveLine();
    }
  }

  async retryingChunk(
    _chunkIndex: number,
    attempt: number,
    maxRetries: number,
    delayMs: number,
  ): Promise<void> {
    this.runPhase = 'retrying';
    if (this.silent) {
      await sleep(delayMs);
      this.runPhase = 'analyzing';
      return;
    }

    const totalSeconds = Math.round(delayMs / COUNTDOWN_TICK_MS);
    if (!this.isTTY) {
      process.stdout.write(
        `⚠️  Server busy (503). Retrying in ${totalSeconds}s... [Attempt ${attempt}/${maxRetries}]\n`,
      );
      await sleep(delayMs);
      this.runPhase = 'analyzing';
      return;
    }

    for (let remaining = totalSeconds; remaining > 0; remaining--) {
      this.retryLabel = `retrying in ${remaining}s (${attempt}/${maxRetries})`;
      this.renderLiveLine();
      await sleep(COUNTDOWN_TICK_MS);
    }
    this.retryLabel = undefined;
    this.runPhase = 'analyzing';
  }

  skipRemaining(fromIndex: number): void {
    for (let i = fromIndex; i < this.allFiles.length; i++) {
      if (this.statuses[i] === 'waiting') {
        this.statuses[i] = 'skipped';
      }
    }
    if (this.silent) return;
    if (this.isTTY) {
      this.renderLiveLine();
    }
  }

  getStatuses(): readonly FileStatus[] {
    return this.statuses;
  }

  finish(): void {
    this.stopDotAnimation();
    if (this.silent) return;
    if (this.isTTY) {
      this.eraseLiveLine();
    }
  }

  private filesAnalyzedCount(): number {
    return this.statuses
      .slice(0, this.processableTotal)
      .filter((s) => s === 'done' || s === 'failed').length;
  }

  private buildLiveLine(): string {
    const total = this.processableTotal;
    const dots = DOT_FRAMES[this.dotFrameIndex];
    if (this.runPhase === 'retrying') {
      return yellow(`Analyzing ${total} files${dots} ${this.retryLabel ?? 'retrying...'}`);
    }
    const analyzed = this.filesAnalyzedCount();
    const base = `Analyzing ${total} files${dots}`;
    if (analyzed > 0) {
      return cyan(`${base} (${analyzed}/${total})`);
    }
    return cyan(base);
  }

  private startDotAnimation(): void {
    if (this.dotAnimationTimer) return;
    this.dotAnimationTimer = setInterval(() => {
      this.dotFrameIndex = (this.dotFrameIndex + 1) % DOT_FRAMES.length;
      this.renderLiveLine();
    }, DOT_ANIMATION_MS);
  }

  private stopDotAnimation(): void {
    if (!this.dotAnimationTimer) return;
    clearInterval(this.dotAnimationTimer);
    this.dotAnimationTimer = undefined;
  }

  private renderLiveLine(): void {
    this.eraseLiveLine();
    process.stdout.write(this.buildLiveLine() + '\n');
    this.liveLineRendered = true;
  }

  private eraseLiveLine(): void {
    if (!this.liveLineRendered) return;
    readline.moveCursor(process.stdout, 0, -1);
    readline.clearLine(process.stdout, 0);
    this.liveLineRendered = false;
  }
}
