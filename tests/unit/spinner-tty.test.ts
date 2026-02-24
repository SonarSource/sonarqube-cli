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

// Tests for withSpinner TTY path
// Temporarily sets process.stdout.isTTY = true to exercise the animated branch

import { describe, it, expect, spyOn } from 'bun:test';
import { withSpinner } from '../../src/ui/components/spinner.js';

function withTTY(fn: () => Promise<void>): Promise<void> {
  const original = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  return fn().finally(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true });
  });
}

describe('withSpinner: TTY success path', () => {
  it('writes checkmark line after task completes', async () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      await withTTY(async () => {
        await withSpinner('Loading', async () => 'done');
      });
      expect(output.some(s => s.includes('✓') && s.includes('Loading'))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('returns task result in TTY mode', async () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      let result: string | undefined;
      await withTTY(async () => {
        result = await withSpinner('Task', async () => 'value');
      });
      expect(result).toBe('value');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('withSpinner: TTY animation frame', () => {
  it('fires setInterval frame write before task completes', async () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      await withTTY(async () => {
        await withSpinner('Animating', async () => {
          await Bun.sleep(100); // > INTERVAL_MS=80, triggers at least one frame
          return 'done';
        });
      });
      expect(output.some(s => s.startsWith('\r') && s.includes('Animating'))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('withSpinner: TTY error path', () => {
  it('writes failure line when task throws', async () => {
    const output: string[] = [];
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation((s) => {
      output.push(String(s));
      return true;
    });
    try {
      await withTTY(async () => {
        await withSpinner('Failing', async () => {
          throw new Error('tty task error');
        }).catch(() => {});
      });
      expect(output.some(s => s.includes('✗') && s.includes('Failing'))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('propagates error from task in TTY mode', async () => {
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await withTTY(async () => {
        await expect(
          withSpinner('Failing', async () => { throw new Error('propagated'); })
        ).rejects.toThrow('propagated');
      });
    } finally {
      writeSpy.mockRestore();
    }
  });
});
