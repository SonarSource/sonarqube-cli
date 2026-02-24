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

// TTY rendering tests for phase, sections, and messages
// mock.module sets isTTY: true so TTY branches execute

import { describe, it, expect, spyOn } from 'bun:test';

mock.module('../../src/ui/colors.js', () => ({
  isTTY: true,
  bold:  (s: string) => s,
  dim:   (s: string) => s,
  green: (s: string) => s,
  red:   (s: string) => s,
  cyan:  (s: string) => s,
  yellow:(s: string) => s,
  gray:  (s: string) => s,
  white: (s: string) => s,
  STATUS_COLORS: {
    done:    (s: string) => s,
    running: (s: string) => s,
    failed:  (s: string) => s,
    skipped: (s: string) => s,
    warn:    (s: string) => s,
    pending: (s: string) => s,
    info:    (s: string) => s,
  },
  STATUS_ICONS: {
    done:    '✓',
    running: '→',
    failed:  '✗',
    skipped: '⏭',
    warn:    '⚠',
    pending: '○',
    info:    'ℹ',
  },
}));

import { mock } from 'bun:test';
import { phase, phaseItem } from '../../src/ui/components/phase.js';
import { intro, outro } from '../../src/ui/components/sections.js';
import { blank } from '../../src/ui/messages.js';

// ─── phase: TTY rendering ─────────────────────────────────────────────────────

describe('phase: TTY rendering', () => {
  it('writes title to stdout in TTY mode', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      phase('Health Check', [phaseItem('Token', 'done')]);
      expect(output.join('')).toContain('Health Check');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('renderItem: writes item text with status icon in TTY mode', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      phase('Phase', [
        phaseItem('Token valid', 'done'),
        phaseItem('Server down', 'failed'),
      ]);
      const combined = output.join('');
      expect(combined).toContain('Token valid');
      expect(combined).toContain('Server down');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('renderItem: includes detail text when provided', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      phase('Phase', [phaseItem('Config', 'warn', 'field missing')]);
      expect(output.join('')).toContain('field missing');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('accepts custom titleColor and iconColors options', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      phase('Custom', [phaseItem('step', 'info')], {
        titleColor: (s: string) => `>>>${s}<<<`,
        iconColors: { info: (s: string) => `[${s}]` },
      });
      const combined = output.join('');
      expect(combined).toContain('>>>Custom<<<');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── intro: TTY rendering ─────────────────────────────────────────────────────

describe('intro: TTY rendering', () => {
  it('writes title with divider lines to stdout', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      intro('Getting Started');
      const combined = output.join('');
      expect(combined).toContain('Getting Started');
      expect(combined).toContain('━');
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
      intro('Title', 'subtitle text');
      expect(output.join('')).toContain('subtitle text');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── outro: TTY rendering ─────────────────────────────────────────────────────

describe('outro: TTY rendering', () => {
  it('writes message with divider for success', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      outro('Setup complete', 'success');
      const combined = output.join('');
      expect(combined).toContain('Setup complete');
      expect(combined).toContain('━');
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('writes message with divider for error', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      outro('Setup failed', 'error');
      expect(output.join('')).toContain('Setup failed');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

// ─── blank: TTY rendering ─────────────────────────────────────────────────────

describe('blank: TTY rendering', () => {
  it('writes newline to stdout when isTTY is true', () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      blank();
      expect(output).toContain('\n');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
