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

import { SqaaProgress } from '@/core/ui/components/sqaa-progress.ts';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';

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

function countNewlines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

describe('SqaaProgress — non-TTY', () => {
  it('writes nothing on start or finish', () => {
    const progress = new SqaaProgress({
      files: FILES,
      isTTY: false,
      console: new TerminalConsole(),
    });
    const header = captureStdout(() => progress.start());
    expect(header).toBe('');

    progress.updateChunk(0, 'analyzing');
    progress.update(0, 'done');
    progress.update(1, 'failed');
    captureStdout(() => progress.skipRemaining(2));
    const finish = captureStdout(() => progress.finish());
    expect(finish).toBe('');
  });

  it('does not print per-file lines during the run', () => {
    const progress = new SqaaProgress({
      files: FILES,
      isTTY: false,
      console: new TerminalConsole(),
    });
    progress.start();
    progress.update(0, 'done');
    progress.update(1, 'done');
    const during = captureStdout(() => progress.update(2, 'done'));
    expect(during).toBe('');
    const finish = captureStdout(() => progress.finish());
    expect(finish).toBe('');
  });

  it('ignored files do not affect processable total', () => {
    const progress = new SqaaProgress({
      files: FILES,
      ignoredFiles: ['build/output.bin'],
      isTTY: false,
      console: new TerminalConsole(),
    });
    const header = captureStdout(() => progress.start());
    expect(header).toBe('');
    expect(progress.getStatuses()).toHaveLength(4);
  });

  it('retryingChunk prints a countdown line', async () => {
    const progress = new SqaaProgress({
      files: FILES,
      isTTY: false,
      console: new TerminalConsole(),
    });
    progress.start();
    const output = await captureStdoutAsync(() => progress.retryingChunk(0, 1, 3, 1));
    expect(output).toContain('Server busy (503)');
    expect(output).toContain('Attempt 1/3');
  });
});

describe('SqaaProgress — TTY', () => {
  it('shows one live line while running and erases it on finish', () => {
    const progress = new SqaaProgress({
      files: FILES,
      isTTY: true,
      console: new TerminalConsole(),
    });
    const start = captureStdout(() => progress.start());
    expect(start).toMatch(/Analyzing 3 files\.+/);
    expect(start).not.toContain('chunk');
    expect(start).not.toContain('in progress');
    expect(countNewlines(start)).toBe(1);

    const analyzing = captureStdout(() => progress.updateChunk(0, 'analyzing'));
    expect(analyzing).toMatch(/Analyzing 3 files\.+/);
    expect(analyzing).not.toContain('[ANALYZING...]');
    expect(countNewlines(analyzing)).toBe(1);

    progress.update(0, 'done');
    const progressUpdate = captureStdout(() => progress.update(1, 'failed'));
    expect(progressUpdate).toContain('(2/3)');

    captureStdout(() => progress.updateChunk(0, 'done'));
    captureStdout(() => progress.skipRemaining(2));

    const finish = captureStdout(() => progress.finish());
    expect(finish).not.toContain('⣿');
    expect(finish).not.toContain('src/a.ts');
    expect(finish).not.toContain('[FAILED]');
  });

  it('cycles animated dots while the live line is active', async () => {
    const progress = new SqaaProgress({
      files: FILES,
      isTTY: true,
      console: new TerminalConsole(),
    });
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    try {
      progress.start();
      await Bun.sleep(950);
      progress.finish();
      const joined = output.join('');
      expect(joined).toMatch(/Analyzing 3 files\./);
      expect(joined).toMatch(/Analyzing 3 files\.\./);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('retryingChunk updates the single live line', async () => {
    const progress = new SqaaProgress({
      files: FILES,
      isTTY: true,
      console: new TerminalConsole(),
    });
    captureStdout(() => progress.start());
    const output = await captureStdoutAsync(() => progress.retryingChunk(0, 1, 3, 500));
    captureStdout(() => progress.finish());
    expect(output).toContain('retrying');
    expect(output).not.toContain('in progress');
  });

  it('warnPayloadSplit writes to stderr only', () => {
    const progress = new SqaaProgress({
      files: FILES,
      isTTY: true,
      console: new TerminalConsole(),
    });
    captureStdout(() => progress.start());
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const stdout = captureStdout(() => progress.warnPayloadSplit());
      expect(stdout).toContain('\x1B[1A');
      expect(String(stderrSpy.mock.calls[0]?.[0])).toContain('Request size limit reached');
    } finally {
      stderrSpy.mockRestore();
      progress.finish();
    }
  });

  it('warnPayloadSplit erases the live line before writing the warning', () => {
    const progress = new SqaaProgress({
      files: FILES,
      isTTY: true,
      console: new TerminalConsole(),
    });
    captureStdout(() => progress.start());

    const events: Array<'stdout-erase' | 'stderr-warn'> = [];
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      const text = String(chunk);
      if (text.includes('\x1B[1A') || text.includes('\x1b[1A')) {
        events.push('stdout-erase');
      }
      return true;
    });
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => {
      events.push('stderr-warn');
      return true;
    });
    try {
      progress.warnPayloadSplit();
      const warnIdx = events.indexOf('stderr-warn');
      const eraseBeforeWarn = events.lastIndexOf('stdout-erase', warnIdx);
      expect(warnIdx).toBeGreaterThanOrEqual(0);
      expect(eraseBeforeWarn).toBeGreaterThanOrEqual(0);
      expect(eraseBeforeWarn).toBeLessThan(warnIdx);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      progress.finish();
    }
  });
});

describe('SqaaProgress — silent flag (used by --format json)', () => {
  it('writes nothing to stdout', async () => {
    const progress = new SqaaProgress({
      files: FILES,
      silent: true,
      console: new TerminalConsole(),
    });

    const output = await captureStdoutAsync(async () => {
      progress.start();
      progress.updateChunk(0, 'done');
      progress.update(0, 'done');
      progress.warnPayloadSplit();
      progress.skipRemaining(1);
      progress.finish();
      await progress.retryingChunk(0, 1, 3, 1);
    });

    expect(output).toBe('');
  });

  it('still updates internal status for skipRemaining', async () => {
    const progress = new SqaaProgress({
      files: FILES,
      silent: true,
      console: new TerminalConsole(),
    });
    progress.start();

    progress.update(0, 'done');
    progress.skipRemaining(1);
    expect(progress.getStatuses()).toEqual(['done', 'skipped', 'skipped']);

    await progress.retryingChunk(0, 1, 3, 1);
  });
});
