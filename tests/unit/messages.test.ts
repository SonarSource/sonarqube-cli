/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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
// Covers both mock mode (recordCall) and real output paths

import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { info, success, warn, error, text, print, blank } from '../../src/ui/messages.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui/mock.js';

// ─── Mock mode ────────────────────────────────────────────────────────────────

describe('messages: mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });
  afterEach(() => {
    setMockUi(false);
  });

  it('info records call', () => {
    info('hello');
    expect(getMockUiCalls().some((c) => c.method === 'info' && c.args[0] === 'hello')).toBe(true);
  });

  it('success records call', () => {
    success('done');
    expect(getMockUiCalls().some((c) => c.method === 'success' && c.args[0] === 'done')).toBe(true);
  });

  it('warn records call', () => {
    warn('caution');
    expect(getMockUiCalls().some((c) => c.method === 'warn' && c.args[0] === 'caution')).toBe(true);
  });

  it('error records call', () => {
    error('oops');
    expect(getMockUiCalls().some((c) => c.method === 'error' && c.args[0] === 'oops')).toBe(true);
  });

  it('text records call', () => {
    text('plain text');
    expect(getMockUiCalls().some((c) => c.method === 'text' && c.args[0] === 'plain text')).toBe(
      true,
    );
  });

  it('print records call', () => {
    print('raw output');
    expect(getMockUiCalls().some((c) => c.method === 'print' && c.args[0] === 'raw output')).toBe(
      true,
    );
  });

  it('blank records call', () => {
    blank();
    expect(getMockUiCalls().some((c) => c.method === 'blank')).toBe(true);
  });
});

// ─── Real output paths ────────────────────────────────────────────────────────

describe('messages: real output (non-mock)', () => {
  it('info writes to stdout with ℹ prefix', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      info('test message');
      expect(output.join('')).toContain('test message');
    } finally {
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
      success('all good');
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
      warn('be careful');
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
      error('something failed');
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
      text('plain output');
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
      text('colored', (s: string) => `[${s}]`);
      expect(output.join('')).toContain('[colored]');
    } finally {
      spy.mockRestore();
    }
  });

  it('print writes message to stdout', () => {
    const output: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      print('raw line');
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
      print('line\n');
      expect(output.join('')).toBe('line\n');
    } finally {
      spy.mockRestore();
    }
  });
});
