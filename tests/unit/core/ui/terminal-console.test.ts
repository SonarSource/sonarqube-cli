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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { phaseItem } from '@/core/ui';
import { clearMockUiCalls, getMockUiCalls, queueMockResponse, setMockUi } from '@/core/ui/mock.ts';
import { TerminalConsole } from '@/core/ui/terminal-console.ts';

// ─── Mock mode ────────────────────────────────────────────────────────────────

describe('TerminalConsole: mock mode', () => {
  let terminal: TerminalConsole;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    terminal = new TerminalConsole();
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('records message calls', () => {
    terminal.info('hello');
    terminal.success('done');
    terminal.discreetSuccess('quiet');
    terminal.warn('caution');
    terminal.error('oops');
    terminal.text('plain');
    terminal.print('raw');
    terminal.blank();

    const methods = getMockUiCalls().map((c) => c.method);
    expect(methods).toEqual([
      'info',
      'success',
      'discreetSuccess',
      'warn',
      'error',
      'text',
      'print',
      'blank',
    ]);
  });
});

// ─── Real output ──────────────────────────────────────────────────────────────

describe('TerminalConsole: real output', () => {
  let terminal: TerminalConsole;

  beforeEach(() => {
    setMockUi(false);
    terminal = new TerminalConsole();
  });

  it('info writes to stdout', () => {
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

  it('info writes to stderr when requested', () => {
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

  it('success writes to stdout', () => {
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

  it('warn and error write to stderr', () => {
    const output: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.warn('be careful');
      terminal.error('something failed');
      expect(output.join('')).toContain('be careful');
      expect(output.join('')).toContain('something failed');
    } finally {
      spy.mockRestore();
    }
  });

  it('text writes plain output and applies color', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      terminal.text('plain output');
      terminal.text('colored', (s: string) => `[${s}]`);
      expect(output.join('')).toContain('plain output');
      expect(output.join('')).toContain('[colored]');
    } finally {
      spy.mockRestore();
    }
  });

  it('text writes to stderr when requested', () => {
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

  it('print writes raw output', () => {
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

  it('discreetSuccess writes to stdout by default and stderr when requested', () => {
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
      terminal.discreetSuccess('installed');
      terminal.discreetSuccess('on stderr', 'stderr');
      expect(stdout.join('')).toContain('installed');
      expect(stderr.join('')).toContain('on stderr');
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

// ─── Formatted output mode ────────────────────────────────────────────────────

describe('TerminalConsole: formatted output mode', () => {
  let terminal: TerminalConsole;

  beforeEach(() => {
    setMockUi(false);
    terminal = new TerminalConsole();
  });

  it('buffers stdout messages and exposes them via getMessagesForFormattedOutput', () => {
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    terminal.setFormattedOutputMode(true);
    try {
      expect(terminal.isFormattedOutputMode()).toBe(true);
      terminal.info('buffered info');
      terminal.success('buffered success');
      terminal.discreetSuccess('buffered discreet');
      terminal.text('buffered text');

      const messages = terminal.getMessagesForFormattedOutput();
      expect(messages.some((m) => m.includes('buffered info'))).toBe(true);
      expect(messages.some((m) => m.includes('buffered success'))).toBe(true);
      expect(messages.some((m) => m.includes('buffered discreet'))).toBe(true);
      expect(messages).toContain('buffered text');
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      terminal.setFormattedOutputMode(false);
      expect(terminal.isFormattedOutputMode()).toBe(false);
      expect(terminal.getMessagesForFormattedOutput()).toEqual([]);
      stdoutSpy.mockRestore();
    }
  });

  it('does not buffer stderr info or text', () => {
    const stderr: string[] = [];
    const spy = spyOn(process.stderr, 'write').mockImplementation((s) => {
      stderr.push(String(s));
      return true;
    });
    terminal.setFormattedOutputMode(true);
    try {
      terminal.info('stderr info', 'stderr');
      terminal.text('stderr text', undefined, 'stderr');
      terminal.discreetSuccess('stderr discreet', 'stderr');
      expect(stderr.join('')).toContain('stderr info');
      expect(stderr.join('')).toContain('stderr text');
      expect(stderr.join('')).toContain('stderr discreet');
      expect(terminal.getMessagesForFormattedOutput()).toEqual([]);
    } finally {
      terminal.setFormattedOutputMode(false);
      spy.mockRestore();
    }
  });

  it('blank is a no-op while formatted-output mode is active', () => {
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    terminal.setFormattedOutputMode(true);
    try {
      terminal.blank();
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      terminal.setFormattedOutputMode(false);
      stdoutSpy.mockRestore();
    }
  });
});

// ─── Delegation to interactive components ─────────────────────────────────────

describe('TerminalConsole: component delegation', () => {
  let terminal: TerminalConsole;

  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
    terminal = new TerminalConsole();
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('delegates note, phase, intro, and outro', () => {
    terminal.note('body', 'title');
    terminal.phase('Setup', [phaseItem('Step', 'done')]);
    terminal.intro('Title', 'subtitle');
    terminal.outro('Done', 'success', 'detail');

    const methods = getMockUiCalls().map((c) => c.method);
    expect(methods).toContain('note');
    expect(methods).toContain('phase');
    expect(methods).toContain('intro');
    expect(methods).toContain('outro');
  });

  it('delegates withSpinner and prompt helpers', async () => {
    queueMockResponse('answer');
    queueMockResponse('secret');
    queueMockResponse(true);
    queueMockResponse('picked');

    const spinnerResult = await terminal.withSpinner('working', () => Promise.resolve('ok'));
    expect(spinnerResult).toBe('ok');

    expect(await terminal.textPrompt('name?')).toBe('answer');
    expect(await terminal.passwordPrompt('password?')).toBe('secret');
    expect(await terminal.confirmPrompt('continue?', false)).toBe(true);
    expect(await terminal.selectPrompt('pick', [{ label: 'A', value: 'a' }])).toBe('picked');
    expect(await terminal.multiSelectPrompt('pick many', [{ label: 'A', value: 'a' }])).toEqual([]);
    await terminal.pressEnterKeyPrompt('press enter');

    const methods = getMockUiCalls().map((c) => c.method);
    expect(methods).toContain('spinner');
    expect(methods).toContain('textPrompt');
    expect(methods).toContain('passwordPrompt');
    expect(methods).toContain('confirmPrompt');
    expect(methods).toContain('selectPrompt');
    expect(methods).toContain('multiSelectPrompt');
    expect(methods).toContain('pressAnyKeyPrompt');
  });

  it('delegates promptUntilValid', async () => {
    queueMockResponse('valid');
    expect(await terminal.promptUntilValid('value', (v) => v.length > 0, 'invalid')).toBe('valid');
  });
});
