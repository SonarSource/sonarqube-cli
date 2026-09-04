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

// Unit tests for phase, sections, and spinner UI components
// Tests FakeConsole recording and non-TTY plain output paths
// mock.module forces isTTY: false so non-TTY branches execute regardless of terminal

import { beforeEach, describe, expect, it, spyOn } from 'bun:test';

void mock.module('@/core/ui/colors.js', mockColorsNonTTY);

import { mock } from 'bun:test';

import { phaseItem, TerminalConsole } from '@/core/ui';

import { mockColorsNonTTY } from '../../../_common/colors-mock.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

// ─── phaseItem helper ─────────────────────────────────────────────────────────

describe('phaseItem', () => {
  it('creates item with text, status, and no detail by default', () => {
    const item = phaseItem('Checking config', 'done');
    expect(item.text).toBe('Checking config');
    expect(item.status).toBe('done');
    expect(item.detail).toBeUndefined();
  });

  it('creates item with detail when provided', () => {
    const item = phaseItem('Checking config', 'failed', 'file not found');
    expect(item.detail).toBe('file not found');
  });

  it('creates item with sub-items when provided', () => {
    const item = phaseItem('Feature', 'done', undefined, ['~/.config/a', '~/.config/b']);
    expect(item.subItems).toEqual(['~/.config/a', '~/.config/b']);
  });

  it('supports all status values', () => {
    expect(phaseItem('a', 'done').status).toBe('done');
    expect(phaseItem('b', 'failed').status).toBe('failed');
    expect(phaseItem('c', 'warn').status).toBe('warn');
    expect(phaseItem('d', 'pending').status).toBe('pending');
  });
});

// ─── phase: FakeConsole ─────────────────────────────────────────────────────────

describe('phase: FakeConsole', () => {
  let fake: FakeConsole;

  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('records call with title and items', () => {
    const items = [phaseItem('Step 1', 'done')];
    fake.phase('Setup', items);
    const calls = fake.calls;
    expect(calls.some((c) => c.method === 'phase' && c.args[0] === 'Setup')).toBe(true);
  });

  it('does not write to stdout when FakeConsole is installed', () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      fake.phase('Title', [phaseItem('item', 'done')]);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── phase: non-TTY plain output ──────────────────────────────────────────────

describe('phase: non-TTY output', () => {
  it('writes title to stdout', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      new TerminalConsole().phase('Verification', [phaseItem('Token valid', 'done')]);
      expect(output.join('')).toContain('Verification');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('writes each item text to stdout', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      new TerminalConsole().phase('Phase', [
        phaseItem('Step one', 'done'),
        phaseItem('Step two', 'failed'),
      ]);
      const combined = output.join('');
      expect(combined).toContain('Step one');
      expect(combined).toContain('Step two');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('includes item detail in output when present', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      new TerminalConsole().phase('Phase', [phaseItem('Config', 'warn', 'missing field')]);
      expect(output.join('')).toContain('missing field');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('renders sub-items as an indented list under the item', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      new TerminalConsole().phase('Installed', [
        phaseItem('Feature', 'done', undefined, ['~/.config/a', '~/.config/b']),
      ]);
      const combined = output.join('');
      expect(combined).toContain('       ~/.config/a');
      expect(combined).toContain('       ~/.config/b');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── intro: FakeConsole ─────────────────────────────────────────────────────────

describe('intro: FakeConsole', () => {
  let fake: FakeConsole;

  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('records call with title', () => {
    fake.intro('Welcome');
    expect(fake.calls.some((c) => c.method === 'intro' && c.args[0] === 'Welcome')).toBe(true);
  });

  it('does not write to stdout when FakeConsole is installed', () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      fake.intro('Title');
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── intro: non-TTY output ────────────────────────────────────────────────────

describe('intro: non-TTY output', () => {
  it('writes title in plain format', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      new TerminalConsole().intro('Setup Wizard');
      expect(output.join('')).toContain('Setup Wizard');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('includes subtitle when provided', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      new TerminalConsole().intro('Setup', 'v1.0.0');
      const combined = output.join('');
      expect(combined).toContain('Setup');
      expect(combined).toContain('v1.0.0');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── outro: FakeConsole ─────────────────────────────────────────────────────────

describe('outro: FakeConsole', () => {
  let fake: FakeConsole;

  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('records call with message and status', () => {
    fake.outro('Done!', 'success');
    expect(fake.calls.some((c) => c.method === 'outro' && c.args[0] === 'Done!')).toBe(true);
  });
});

// ─── outro: non-TTY output ────────────────────────────────────────────────────

describe('outro: non-TTY output', () => {
  it('writes message for success status', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      new TerminalConsole().outro('All done', 'success');
      expect(output.join('')).toContain('All done');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('writes message for error status', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      new TerminalConsole().outro('Failed', 'error');
      expect(output.join('')).toContain('Failed');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── withSpinner: FakeConsole ───────────────────────────────────────────────────

describe('withSpinner: FakeConsole', () => {
  let fake: FakeConsole;

  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('records call with message', async () => {
    await fake.withSpinner('Loading', () => Promise.resolve(42));
    expect(fake.calls.some((c) => c.method === 'spinner' && c.args[0] === 'Loading')).toBe(true);
  });

  it('returns the task result through FakeConsole', async () => {
    const result = await fake.withSpinner('Fetching', () => Promise.resolve('data'));
    expect(result).toBe('data');
  });

  it('propagates an error thrown by the task', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      fake.withSpinner('Failing', () => {
        throw new Error('task error');
      }),
    ).rejects.toThrow('task error');
  });
});

// ─── withSpinner: non-TTY output ─────────────────────────────────────────────

describe('withSpinner: non-TTY output', () => {
  it('writes message with ellipsis to stdout', async () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      await new TerminalConsole().withSpinner('Processing', () => Promise.resolve('done'));
      expect(output.some((s) => s.includes('Processing'))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('returns task result in non-TTY mode', async () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = await new TerminalConsole().withSpinner('Computing', () =>
        Promise.resolve(99),
      );
      expect(result).toBe(99);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('propagates error thrown by task in non-TTY mode', async () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(
        new TerminalConsole().withSpinner('Failing', () => {
          throw new Error('non-tty error');
        }),
      ).rejects.toThrow('non-tty error');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('writes to the provided stream (stderr) instead of stdout', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      stdout.push(String(s));
      return true;
    });
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      stderr.push(String(s));
      return true;
    });
    try {
      await new TerminalConsole().withSpinner('On stderr', () => Promise.resolve('done'), 'stderr');
      expect(stderr.some((s) => s.includes('On stderr'))).toBe(true);
      expect(stdout.join('')).not.toContain('On stderr');
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
