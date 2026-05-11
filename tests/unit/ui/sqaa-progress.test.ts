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

// Unit tests for SqaaProgress — TTY and non-TTY rendering paths.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../src/ui';
import { SqaaProgress } from '../../../src/ui/components/sqaa-progress.js';

const FILES = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

async function captureStdoutAsync(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

describe('SqaaProgress — non-TTY mode', () => {
  it('prints a one-time header, rolling per-file result lines, and skipped files on fail-fast', () => {
    const progress = new SqaaProgress({ files: FILES, isTTY: false });

    const header = captureStdout(() => progress.start());
    expect(header).toContain('Analyzing 3 files');

    // Result lines arrive in completion order (rolling), one per terminal transition.
    const aLine = captureStdout(() => progress.update(0, 'done'));
    expect(aLine).toContain('src/a.ts');
    // Intermediate transitions don't print anything in non-TTY mode.
    expect(captureStdout(() => progress.update(1, 'analyzing'))).toBe('');
    const bLine = captureStdout(() => progress.update(1, 'failed'));
    expect(bLine).toContain('src/b.ts');

    // Fail-fast: c.ts is never picked up, finish() flushes it as skipped.
    captureStdout(() => progress.skipRemaining(2));
    const finish = captureStdout(() => progress.finish(2));
    expect(finish).toContain('src/c.ts');
  });

  it('header counts only files the pool will process (excludes pre-ignored files)', () => {
    const progress = new SqaaProgress({
      files: FILES,
      ignoredFiles: ['build/output.bin'],
      isTTY: false,
    });

    const header = captureStdout(() => progress.start());
    // Only the 3 waiting files count; the binary one is already accounted for elsewhere.
    expect(header).toContain('Analyzing 3 files');
  });

  it('retrying prints a countdown line and resets status to analyzing', async () => {
    const progress = new SqaaProgress({ files: FILES, isTTY: false });
    const output = await captureStdoutAsync(() => progress.retrying(0, 1, 3, 1));
    expect(output).toContain('Server busy (503)');
    expect(output).toContain('Attempt 1/3');
  });
});

describe('SqaaProgress — TTY mode', () => {
  it('renders full block with all statuses through a complete lifecycle', () => {
    const progress = new SqaaProgress({ files: FILES, isTTY: true });

    const start = captureStdout(() => progress.start());
    expect(start).toContain('SonarQube Agentic Analysis in progress');
    expect(start).toContain('0/3 files analyzed');
    expect(start).toContain('[WAITING]');

    const analyzing = captureStdout(() => progress.update(0, 'analyzing'));
    expect(analyzing).toContain('[ANALYZING...]');

    const done = captureStdout(() => progress.update(0, 'done'));
    expect(done).toContain('[DONE]');
    expect(done).toContain('1/3 files analyzed');

    const failed = captureStdout(() => progress.update(1, 'failed'));
    expect(failed).toContain('[FAILED]');

    captureStdout(() => progress.skipRemaining(2));
    const finish = captureStdout(() => progress.finish(2));
    expect(finish).toContain('2/3 files analyzed');
    expect(finish).toContain('[DONE]');
    expect(finish).toContain('[FAILED]');
    expect(finish).toContain('[SKIPPED]');
  });

  it('retrying shows live countdown label and resets to analyzing', async () => {
    const progress = new SqaaProgress({ files: FILES, isTTY: true });
    captureStdout(() => progress.start());
    // 500ms rounds to 1s so the countdown loop body executes once.
    const output = await captureStdoutAsync(() => progress.retrying(0, 1, 3, 500));
    expect(output).toContain('RETRYING');

    const after = captureStdout(() => progress.update(0, 'done'));
    expect(after).not.toContain('[RETRYING...]');
  });

  it('progress bar denominator excludes pre-ignored files', () => {
    // 3 analyzable + 1 ignored. Bar total must be 3 (so 100% is reachable),
    // not 4. Ignored files still appear in the listing below the bar.
    const progress = new SqaaProgress({
      files: FILES,
      ignoredFiles: ['build/output.bin'],
      isTTY: true,
    });

    const start = captureStdout(() => progress.start());
    expect(start).toContain('0/3 files analyzed');
    expect(start).not.toContain('0/4 files analyzed');

    const afterDone = captureStdout(() => progress.update(0, 'done'));
    expect(afterDone).toContain('1/3 files analyzed');

    progress.update(1, 'done');
    progress.update(2, 'done');
    const finish = captureStdout(() => progress.finish(3));
    expect(finish).toContain('3/3 files analyzed');
    // Ignored entry is still listed below the summary bar.
    expect(finish).toContain('build/output.bin');
    expect(finish).toContain('[IGNORED]');
  });
});

describe('SqaaProgress — mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });
  afterEach(() => setMockUi(false));

  it('records all method calls and writes nothing to stdout', async () => {
    const progress = new SqaaProgress({ files: FILES });

    const output = captureStdout(() => {
      progress.start();
      progress.update(0, 'done');
      progress.skipRemaining(1);
      progress.finish(3);
    });
    await progress.retrying(0, 1, 3, 1);

    expect(output).toBe('');
    const methods = getMockUiCalls().map((c) => c.method);
    expect(methods).toContain('sqaaProgress.start');
    expect(methods).toContain('sqaaProgress.update');
    expect(methods).toContain('sqaaProgress.skipRemaining');
    expect(methods).toContain('sqaaProgress.finish');
    expect(methods).toContain('sqaaProgress.retrying');
  });
});

describe('SqaaProgress — silent flag (used by --format json)', () => {
  // Silent mode is the production replacement for setMockUi(true) in JSON mode:
  // it must not write to stdout, must not record calls into the global mock
  // buffer, and must still update internal status so consumers can read it.

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });
  afterEach(() => setMockUi(false));

  it('writes nothing to stdout and records no mock calls even when mock is active', async () => {
    const progress = new SqaaProgress({ files: FILES, silent: true });

    const output = await captureStdoutAsync(async () => {
      progress.start();
      progress.update(0, 'done');
      progress.skipRemaining(1);
      progress.finish(3);
      await progress.retrying(2, 1, 3, 1);
    });

    expect(output).toBe('');
    // Crucially: no entries pushed into the global mock buffer (the original
    // setMockUi(true) approach grew this array unboundedly during JSON runs).
    expect(getMockUiCalls()).toHaveLength(0);
  });

  it('still updates internal status for skipRemaining and retrying', async () => {
    const progress = new SqaaProgress({ files: FILES, silent: true });

    progress.update(0, 'done');
    progress.skipRemaining(1);
    expect(progress.getStatuses()).toEqual(['done', 'skipped', 'skipped']);

    // retrying() preserves the wait so retry semantics are unchanged, and
    // resets the status back to 'analyzing' on completion.
    await progress.retrying(0, 1, 3, 1);
    expect(progress.getStatuses()[0]).toBe('analyzing');
  });
});
