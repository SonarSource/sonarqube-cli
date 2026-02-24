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

/**
 * Tests for note() component:
 * - mock mode: records call, skips rendering
 * - TTY box rendering (renderTTY): borders, title, content, string splitting
 */

import { mock, describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';

// Override colors to simulate TTY environment — must be before any imports
mock.module('../../src/ui/colors.js', () => ({
  isTTY: true,
  bold: (s: string) => s,
  dim: (s: string) => s,
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
  cyan: (s: string) => s,
  gray: (s: string) => s,
  white: (s: string) => s,
}));

import { note } from '../../src/ui/components/note.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui/mock.js';

// ─── Mock mode ────────────────────────────────────────────────────────────────

describe('note(): mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('records call without writing to stdout', () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      note('some content', 'My Title');
      const calls = getMockUiCalls();
      expect(calls.some(c => c.method === 'note')).toBe(true);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('records content and title arguments', () => {
    note(['line1', 'line2'], 'Section Title');
    const calls = getMockUiCalls();
    const noteCall = calls.find(c => c.method === 'note');
    expect(noteCall).toBeDefined();
    expect(noteCall!.args[0]).toEqual(['line1', 'line2']);
    expect(noteCall!.args[1]).toBe('Section Title');
  });

  it('records call without title when title is omitted', () => {
    note('plain content');
    const calls = getMockUiCalls();
    expect(calls.some(c => c.method === 'note')).toBe(true);
  });
});

// ─── TTY box rendering ────────────────────────────────────────────────────────

describe('note(): TTY box rendering (renderTTY)', () => {
  it('renders box borders around content', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      note(['First line', 'Second line']);
      expect(writeSpy).toHaveBeenCalled();
      const rendered = output.join('');
      expect(rendered).toContain('First line');
      expect(rendered).toContain('Second line');
      expect(rendered).toContain('┌');
      expect(rendered).toContain('└');
      expect(rendered).toContain('│');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('renders title in the top border', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      note(['content line'], 'My Title');
      const rendered = output.join('');
      expect(rendered).toContain('My Title');
      expect(rendered).toContain('┌─');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('splits string content by newlines', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      note('line one\nline two');
      const rendered = output.join('');
      expect(rendered).toContain('line one');
      expect(rendered).toContain('line two');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('renders box without title (plain border)', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      note(['only content']);
      const rendered = output.join('');
      expect(rendered).toContain('only content');
      // No title → plain top border starting with '┌─'
      expect(rendered).toContain('┌');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('appends newline at the end', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      note(['content']);
      const rendered = output.join('');
      expect(rendered.endsWith('\n')).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
