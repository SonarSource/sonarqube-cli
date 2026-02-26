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

// Unit tests for phase, sections, and spinner UI components
// Tests mock mode and non-TTY plain output paths
// mock.module forces isTTY: false so non-TTY branches execute regardless of terminal

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

void mock.module('../../src/ui/colors.js', () => ({
  isTTY: false,
  bold: (s: string) => s,
  dim: (s: string) => s,
  green: (s: string) => s,
  red: (s: string) => s,
  cyan: (s: string) => s,
  yellow: (s: string) => s,
  gray: (s: string) => s,
  white: (s: string) => s,
  STATUS_COLORS: {
    done: (s: string) => s,
    running: (s: string) => s,
    failed: (s: string) => s,
    skipped: (s: string) => s,
    warn: (s: string) => s,
    pending: (s: string) => s,
    info: (s: string) => s,
    success: (s: string) => s,
    error: (s: string) => s,
    warning: (s: string) => s,
  },
  STATUS_ICONS: {
    done: '✓',
    running: '→',
    failed: '✗',
    skipped: '⏭',
    warn: '⚠',
    pending: '○',
    info: 'ℹ',
    success: '✓',
    error: '✗',
    warning: '⚠',
  },
}));

import { mock } from 'bun:test';
import { phase, phaseItem } from '../../src/ui/components/phase.js';
import { intro, outro } from '../../src/ui/components/sections.js';
import { withSpinner } from '../../src/ui/components/spinner.js';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui/mock.js';

// ─── phaseItem helper ─────────────────────────────────────────────────────────

describe('phaseItem', () => {
  it('creates item with text, status, and no detail by default', () => {
    const item = phaseItem('Checking config', 'success');
    expect(item.text).toBe('Checking config');
    expect(item.status).toBe('success');
    expect(item.detail).toBeUndefined();
  });

  it('creates item with detail when provided', () => {
    const item = phaseItem('Checking config', 'error', 'file not found');
    expect(item.detail).toBe('file not found');
  });

  it('supports all status values', () => {
    expect(phaseItem('a', 'success').status).toBe('success');
    expect(phaseItem('b', 'error').status).toBe('error');
    expect(phaseItem('c', 'warning').status).toBe('warning');
    expect(phaseItem('d', 'pending').status).toBe('pending');
  });
});

// ─── phase: mock mode ─────────────────────────────────────────────────────────

describe('phase: mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });
  afterEach(() => {
    setMockUi(false);
  });

  it('records call with title and items', () => {
    const items = [phaseItem('Step 1', 'success')];
    phase('Setup', items);
    const calls = getMockUiCalls();
    expect(calls.some((c) => c.method === 'phase' && c.args[0] === 'Setup')).toBe(true);
  });

  it('does not write to stdout in mock mode', () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      phase('Title', [phaseItem('item', 'success')]);
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
      phase('Verification', [phaseItem('Token valid', 'success')]);
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
      phase('Phase', [phaseItem('Step one', 'success'), phaseItem('Step two', 'error')]);
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
      phase('Phase', [phaseItem('Config', 'warning', 'missing field')]);
      expect(output.join('')).toContain('missing field');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── intro: mock mode ─────────────────────────────────────────────────────────

describe('intro: mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });
  afterEach(() => {
    setMockUi(false);
  });

  it('records call with title', () => {
    intro('Welcome');
    expect(getMockUiCalls().some((c) => c.method === 'intro' && c.args[0] === 'Welcome')).toBe(
      true,
    );
  });

  it('does not write to stdout in mock mode', () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      intro('Title');
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
      intro('Setup Wizard');
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
      intro('Setup', 'v1.0.0');
      const combined = output.join('');
      expect(combined).toContain('Setup');
      expect(combined).toContain('v1.0.0');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── outro: mock mode ─────────────────────────────────────────────────────────

describe('outro: mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });
  afterEach(() => {
    setMockUi(false);
  });

  it('records call with message and status', () => {
    outro('Done!', 'success');
    expect(getMockUiCalls().some((c) => c.method === 'outro' && c.args[0] === 'Done!')).toBe(true);
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
      outro('All done', 'success');
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
      outro('Failed', 'error');
      expect(output.join('')).toContain('Failed');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── withSpinner: mock mode ───────────────────────────────────────────────────

describe('withSpinner: mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });
  afterEach(() => {
    setMockUi(false);
  });

  it('records call with message', async () => {
    await withSpinner('Loading', () => 42);
    expect(getMockUiCalls().some((c) => c.method === 'spinner' && c.args[0] === 'Loading')).toBe(
      true,
    );
  });

  it('returns task result in mock mode', async () => {
    const result = await withSpinner('Fetching', () => 'data');
    expect(result).toBe('data');
  });

  it('propagates error thrown by task in mock mode', () => {
    expect(
      withSpinner('Failing', () => {
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
      await withSpinner('Processing', () => 'done');
      expect(output.some((s) => s.includes('Processing'))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('returns task result in non-TTY mode', async () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const result = await withSpinner('Computing', () => 99);
      expect(result).toBe(99);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('propagates error thrown by task in non-TTY mode', () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(
        withSpinner('Failing', () => {
          throw new Error('non-tty error');
        }),
      ).rejects.toThrow('non-tty error');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
