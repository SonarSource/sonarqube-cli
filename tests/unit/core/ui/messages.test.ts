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

// Tests for messages.ts: info, success, warn, error, text, print, blank
// Covers both FakeConsole recording and real output paths

import { beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { TerminalConsole } from '@/core/ui';

import { FakeConsole } from '../../../_common/fake-console.ts';

// ─── FakeConsole ────────────────────────────────────────────────────────────────

describe('messages: FakeConsole', () => {
  let fake: FakeConsole;

  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('info records call', () => {
    fake.info('hello');
    expect(fake.calls.some((c) => c.method === 'info' && c.args[0] === 'hello')).toBe(true);
  });

  it('success records call', () => {
    fake.success('done');
    expect(fake.calls.some((c) => c.method === 'success' && c.args[0] === 'done')).toBe(true);
  });

  it('warn records call', () => {
    fake.warn('caution');
    expect(fake.calls.some((c) => c.method === 'warn' && c.args[0] === 'caution')).toBe(true);
  });

  it('error records call', () => {
    fake.error('oops');
    expect(fake.calls.some((c) => c.method === 'error' && c.args[0] === 'oops')).toBe(true);
  });

  it('text records call', () => {
    fake.text('plain text');
    expect(fake.calls.some((c) => c.method === 'text' && c.args[0] === 'plain text')).toBe(true);
  });

  it('print records call', () => {
    fake.print('raw output');
    expect(fake.calls.some((c) => c.method === 'print' && c.args[0] === 'raw output')).toBe(true);
  });

  it('blank records call', () => {
    fake.blank();
    expect(fake.calls.some((c) => c.method === 'blank')).toBe(true);
  });
});

// ─── Real output paths

describe('messages: real output (non-mock)', () => {
  let terminal: TerminalConsole;

  beforeEach(() => {
    terminal = new TerminalConsole();
  });

  it('info writes to stdout with ℹ prefix', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.info('test message');
      expect(output.join('')).toContain('test message');
    } finally {
      spy.mockRestore();
    }
  });

  it('info writes to stderr when an explicit stderr stream is passed', () => {
    const output: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.info('test message', 'stderr');
      expect(output.join('')).toContain('test message');
    } finally {
      spy.mockRestore();
    }
  });

  it('info on stderr is not buffered in formatted-output mode', () => {
    const output: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    terminal.setFormattedOutputMode(true);
    try {
      terminal.info('test message', 'stderr');
      expect(output.join('')).toContain('test message');
      expect(terminal.getMessagesForFormattedOutput()).toEqual([]);
    } finally {
      terminal.setFormattedOutputMode(false);
      spy.mockRestore();
    }
  });

  it('success writes to stdout with ✓ prefix', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.success('all good');
      expect(output.join('')).toContain('all good');
    } finally {
      spy.mockRestore();
    }
  });

  it('warn writes to stderr', () => {
    const output: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.warn('be careful');
      expect(output.join('')).toContain('be careful');
    } finally {
      spy.mockRestore();
    }
  });

  it('error writes to stderr', () => {
    const output: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.error('something failed');
      expect(output.join('')).toContain('something failed');
    } finally {
      spy.mockRestore();
    }
  });

  it('text writes plain message to stdout', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.text('plain output');
      expect(output.join('')).toContain('plain output');
    } finally {
      spy.mockRestore();
    }
  });

  it('text applies color function when provided', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.text('colored', (s: string) => `[${s}]`);
      expect(output.join('')).toContain('[colored]');
    } finally {
      spy.mockRestore();
    }
  });

  it('text writes to stderr when an explicit stderr stream is passed', () => {
    const output: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.text('to stderr', undefined, 'stderr');
      expect(output.join('')).toContain('to stderr');
    } finally {
      spy.mockRestore();
    }
  });

  it('text on stderr is not buffered in formatted-output mode', () => {
    const output: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    terminal.setFormattedOutputMode(true);
    try {
      terminal.text('to stderr', undefined, 'stderr');
      expect(output.join('')).toContain('to stderr');
      expect(terminal.getMessagesForFormattedOutput()).toEqual([]);
    } finally {
      terminal.setFormattedOutputMode(false);
      spy.mockRestore();
    }
  });

  it('text on stdout is buffered in formatted-output mode', () => {
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    terminal.setFormattedOutputMode(true);
    try {
      terminal.text('buffered text');
      expect(
        terminal.getMessagesForFormattedOutput().some((m) => m.includes('buffered text')),
      ).toBe(true);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      terminal.setFormattedOutputMode(false);
      stdoutSpy.mockRestore();
    }
  });

  it('print writes message to stdout', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.print('raw line');
      expect(output.join('')).toContain('raw line');
    } finally {
      spy.mockRestore();
    }
  });

  it('print does not add extra newline when message already ends with newline', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.print('line\n');
      expect(output.join('')).toBe('line\n');
    } finally {
      spy.mockRestore();
    }
  });

  it('discreetSuccess writes to stdout by default', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.discreetSuccess('installed');
      expect(output.join('')).toContain('installed');
    } finally {
      spy.mockRestore();
    }
  });

  it('discreetSuccess writes to stderr when an explicit stderr stream is passed', () => {
    const output: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.discreetSuccess('installed', 'stderr');
      expect(output.join('')).toContain('installed');
    } finally {
      spy.mockRestore();
    }
  });

  it('discreetSuccess on stderr is not buffered in formatted-output mode', () => {
    const output: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    terminal.setFormattedOutputMode(true);
    try {
      terminal.discreetSuccess('installed', 'stderr');
      expect(output.join('')).toContain('installed');
      expect(terminal.getMessagesForFormattedOutput()).toEqual([]);
    } finally {
      terminal.setFormattedOutputMode(false);
      spy.mockRestore();
    }
  });

  it('discreetSuccess on stdout is buffered in formatted-output mode', () => {
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    terminal.setFormattedOutputMode(true);
    try {
      terminal.discreetSuccess('buffered line');
      expect(
        terminal.getMessagesForFormattedOutput().some((m) => m.includes('buffered line')),
      ).toBe(true);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      terminal.setFormattedOutputMode(false);
      stdoutSpy.mockRestore();
    }
  });
});
