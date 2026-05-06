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
  it('prints batch header, file results, and skipped files on fail-fast', () => {
    const progress = new SqaaProgress({ files: FILES, isTTY: false });

    const header = captureStdout(() => progress.startBatch(0, 2));
    expect(header).toContain('Analyzing files 1–2 of 3');

    progress.update(0, 'done');
    progress.update(1, 'failed');
    const commit = captureStdout(() => progress.commitBatch(0, 2));
    expect(commit).toContain('src/a.ts');
    expect(commit).toContain('src/b.ts');
    expect(commit.endsWith('\n\n')).toBe(true);

    captureStdout(() => progress.skipRemaining(2));
    const finish = captureStdout(() => progress.finish(2));
    expect(finish).toContain('src/c.ts'); // skipped file printed in finish
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

    const start = captureStdout(() => progress.startBatch(0, 3));
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
    captureStdout(() => progress.startBatch(0, 3));
    // 500ms rounds to 1s so the countdown loop body executes once.
    const output = await captureStdoutAsync(() => progress.retrying(0, 1, 3, 500));
    expect(output).toContain('RETRYING');

    const after = captureStdout(() => progress.update(0, 'done'));
    expect(after).not.toContain('[RETRYING...]');
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
      progress.startBatch(0, 3);
      progress.update(0, 'done');
      progress.commitBatch(0, 3);
      progress.skipRemaining(1);
      progress.finish(3);
    });
    await progress.retrying(0, 1, 3, 1);

    expect(output).toBe('');
    const methods = getMockUiCalls().map((c) => c.method);
    expect(methods).toContain('sqaaProgress.startBatch');
    expect(methods).toContain('sqaaProgress.update');
    expect(methods).toContain('sqaaProgress.commitBatch');
    expect(methods).toContain('sqaaProgress.skipRemaining');
    expect(methods).toContain('sqaaProgress.finish');
    expect(methods).toContain('sqaaProgress.retrying');
  });
});
