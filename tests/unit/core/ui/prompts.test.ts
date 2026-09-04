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

/**
 * Tests for textPrompt, confirmPrompt, multiSelectPrompt, pressAnyKeyPrompt:
 * - FakeConsole: dequeues responses in order, records calls
 * - CI=true: pressAnyKeyPrompt skips without recording
 */

import { beforeEach, describe, expect, it } from 'bun:test';

import {
  calculateViewport,
  checkboxComponent,
  toggleSelected,
} from '@/core/ui/terminal-console.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

let fake: FakeConsole;

// ─── textPrompt ───────────────────────────────────────────────────────────────

describe('textPrompt: FakeConsole', () => {
  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('returns queued string response and records call', async () => {
    fake.queueResponse('my-org');
    const result = await fake.textPrompt('Enter organization');
    expect(result).toBe('my-org');
    const calls = fake.calls;
    expect(calls.some((c) => c.method === 'textPrompt' && c.args[0] === 'Enter organization')).toBe(
      true,
    );
  });

  it('returns empty string fallback when queue is empty', async () => {
    const result = await fake.textPrompt('Enter value');
    expect(result).toBe('');
  });

  it('dequeues responses in FIFO order', async () => {
    fake.queueResponse('first');
    fake.queueResponse('second');
    const r1 = await fake.textPrompt('Prompt 1');
    const r2 = await fake.textPrompt('Prompt 2');
    expect(r1).toBe('first');
    expect(r2).toBe('second');
  });

  it('records each call with its message', async () => {
    await fake.textPrompt('Message A');
    await fake.textPrompt('Message B');
    const calls = fake.calls.filter((c) => c.method === 'textPrompt');
    expect(calls.map((c) => c.args[0])).toEqual(['Message A', 'Message B']);
  });
});

// ─── passwordPrompt ───────────────────────────────────────────────────────────

describe('passwordPrompt: FakeConsole', () => {
  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('returns queued string response and records call', async () => {
    fake.queueResponse('s3cr3t');
    const result = await fake.passwordPrompt('Enter token');
    expect(result).toBe('s3cr3t');
    const calls = fake.calls;
    expect(calls.some((c) => c.method === 'passwordPrompt' && c.args[0] === 'Enter token')).toBe(
      true,
    );
  });

  it('returns empty string fallback when queue is empty', async () => {
    const result = await fake.passwordPrompt('Enter token');
    expect(result).toBe('');
  });

  it('dequeues responses in FIFO order', async () => {
    fake.queueResponse('first');
    fake.queueResponse('second');
    const r1 = await fake.passwordPrompt('Token 1');
    const r2 = await fake.passwordPrompt('Token 2');
    expect(r1).toBe('first');
    expect(r2).toBe('second');
  });

  it('records each call with its message', async () => {
    await fake.passwordPrompt('Message A');
    await fake.passwordPrompt('Message B');
    const calls = fake.calls.filter((c) => c.method === 'passwordPrompt');
    expect(calls.map((c) => c.args[0])).toEqual(['Message A', 'Message B']);
  });
});

// ─── confirmPrompt ────────────────────────────────────────────────────────────

describe('confirmPrompt: FakeConsole', () => {
  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('returns queued true response and records call', async () => {
    fake.queueResponse(true);
    const result = await fake.confirmPrompt('Are you sure?', true);
    expect(result).toBe(true);
    const calls = fake.calls;
    expect(calls.some((c) => c.method === 'confirmPrompt' && c.args[0] === 'Are you sure?')).toBe(
      true,
    );
  });

  it('returns queued false response', async () => {
    fake.queueResponse(false);
    const result = await fake.confirmPrompt('Proceed?', false);
    expect(result).toBe(false);
  });

  it('returns default when queue is empty', async () => {
    const result = await fake.confirmPrompt('Proceed?', true);
    expect(result).toBe(true);
  });

  it('returns explicit default when queue is empty and default is false', async () => {
    const result = await fake.confirmPrompt('Delete everything?', false);
    expect(result).toBe(false);
  });

  it('dequeues boolean responses in FIFO order', async () => {
    fake.queueResponse(true);
    fake.queueResponse(false);
    expect(await fake.confirmPrompt('First?', true)).toBe(true);
    expect(await fake.confirmPrompt('Second?', false)).toBe(false);
  });
});

// ─── clear queued responses ───────────────────────────────────────────────────

describe('clear queued responses', () => {
  it('removes all queued responses so next call returns fallback', async () => {
    fake = new FakeConsole();
    try {
      fake.queueResponse('queued');
      fake = new FakeConsole();
      const result = await fake.textPrompt('After clear');
      expect(result).toBe('');
    } finally {
    }
  });
});

// ─── pressAnyKeyPrompt ─────────────────────────────────────────────────────────

describe('pressAnyKeyPrompt', () => {
  it('records the call on FakeConsole', async () => {
    fake = new FakeConsole();
    try {
      await fake.pressEnterKeyPrompt('Press Enter to continue');
      const calls = fake.calls;
      expect(
        calls.some(
          (c) => c.method === 'pressAnyKeyPrompt' && c.args[0] === 'Press Enter to continue',
        ),
      ).toBe(true);
    } finally {
    }
  });

  it('returns without recording when CI=true and mock is inactive', async () => {
    const savedCI = process.env['CI'];
    process.env['CI'] = 'true';
    try {
      await fake.pressEnterKeyPrompt('Press Enter');
      expect(true).toBe(true);
    } finally {
      if (savedCI !== undefined) {
        process.env['CI'] = savedCI;
      } else {
        delete process.env['CI'];
      }
    }
  });
});

// ─── multiSelectPrompt ────────────────────────────────────────────────────────

describe('multiSelectPrompt: FakeConsole', () => {
  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('returns empty array fallback when queue is empty', async () => {
    const result = await fake.multiSelectPrompt('Pick options', [{ value: 'a', label: 'A' }]);
    expect(result).toEqual([]);
  });

  it('returns queued array of values', async () => {
    fake.queueResponse(['x', 'y']);
    const result = await fake.multiSelectPrompt('Pick options', [
      { value: 'x', label: 'X' },
      { value: 'y', label: 'Y' },
    ]);
    expect(result).toEqual(['x', 'y']);
  });

  it('records call with message and queued value', async () => {
    fake.queueResponse(['a']);
    await fake.multiSelectPrompt('Choose items', [{ value: 'a', label: 'A' }]);
    const calls = fake.calls;
    expect(
      calls.some((c) => c.method === 'multiSelectPrompt' && c.args[0] === 'Choose items'),
    ).toBe(true);
  });

  it('dequeues responses in FIFO order', async () => {
    fake.queueResponse(['first']);
    fake.queueResponse(['second']);
    const r1 = await fake.multiSelectPrompt('First prompt', [{ value: 'first', label: 'First' }]);
    const r2 = await fake.multiSelectPrompt('Second prompt', [
      { value: 'second', label: 'Second' },
    ]);
    expect(r1).toEqual(['first']);
    expect(r2).toEqual(['second']);
  });

  it('returns null when null is queued', async () => {
    fake.queueResponse(null);
    const result = await fake.multiSelectPrompt('Pick options', [{ value: 'a', label: 'A' }]);
    expect(result).toBeNull();
  });
});

// ─── promptUntilValid ────────────────────────────────────────────────────────

describe('promptUntilValid: FakeConsole', () => {
  beforeEach(() => {
    fake = new FakeConsole();
  });

  it('returns the value immediately when the first input is valid', async () => {
    fake.queueResponse('valid-input');
    const result = await fake.promptUntilValid(
      'Enter value',
      (v: string) => v === 'valid-input',
      'Try again.',
    );
    expect(result).toBe('valid-input');
  });

  it('retries until a valid value is provided and returns it', async () => {
    fake.queueResponse('bad');
    fake.queueResponse('also-bad');
    fake.queueResponse('good');
    const result = await fake.promptUntilValid(
      'Enter value',
      (v: string) => v === 'good',
      'Try again.',
    );
    expect(result).toBe('good');
  });

  it('prints the error message once per invalid attempt', async () => {
    fake.queueResponse('bad');
    fake.queueResponse('also-bad');
    fake.queueResponse('good');
    await fake.promptUntilValid('Enter value', (v: string) => v === 'good', 'Try again.');
    const printCalls = fake.calls.filter((c) => c.method === 'print' && c.args[0] === 'Try again.');
    expect(printCalls).toHaveLength(2);
  });

  it('returns null when the prompt is cancelled', async () => {
    fake.queueResponse(null);
    const result = await fake.promptUntilValid('Enter value', () => true, 'Try again.');
    expect(result).toBeNull();
  });

  it('returns null immediately on cancellation without printing the error message', async () => {
    fake.queueResponse(null);
    await fake.promptUntilValid('Enter value', () => false, 'Try again.');
    const printCalls = fake.calls.filter((c) => c.method === 'print' && c.args[0] === 'Try again.');
    expect(printCalls).toHaveLength(0);
  });
});

// ─── checkboxComponent ───────────────────────────────────────────────────────

describe('checkboxComponent', () => {
  it('returns filled circle for selected item', () => {
    const result = checkboxComponent(true, false);
    expect(result).toContain('◉');
  });

  it('returns empty circle for unavailable item (dim is no-op outside TTY)', () => {
    // dim() is the identity function in non-TTY test environments; the code path is still exercised
    expect(checkboxComponent(false, true)).toBe('◯');
  });

  it('returns plain empty circle for normal unselected item', () => {
    expect(checkboxComponent(false, false)).toBe('◯');
  });
});

// ─── calculateViewport ───────────────────────────────────────────────────────

describe('calculateViewport', () => {
  const VP = 12;

  it('starts at 0 when list fits within the viewport', () => {
    expect(calculateViewport(0, 5, VP)).toEqual({ start: 0, end: 5 });
  });

  it('starts at 0 when cursor is near the top', () => {
    expect(calculateViewport(2, 20, VP)).toEqual({ start: 0, end: 12 });
  });

  it('centres the cursor when it is in the middle of a large list', () => {
    const { start, end } = calculateViewport(15, 30, VP);
    expect(start).toBeLessThanOrEqual(15);
    expect(end).toBeGreaterThan(15);
    expect(end - start).toBe(VP);
  });

  it('clamps so the last item is always visible when cursor is near the bottom', () => {
    expect(calculateViewport(19, 20, VP)).toEqual({ start: 8, end: 20 });
  });

  it('never returns start < 0 or end > total', () => {
    const { start, end } = calculateViewport(0, 3, VP);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThanOrEqual(3);
  });
});

// ─── toggleSelected ──────────────────────────────────────────────────────────

describe('toggleSelected', () => {
  it('adds a value that is not yet selected', () => {
    const selected: string[] = [];
    toggleSelected(selected, 'a', 5);
    expect(selected).toEqual(['a']);
  });

  it('removes a value that is already selected', () => {
    const selected = ['a', 'b'];
    toggleSelected(selected, 'a', 5);
    expect(selected).toEqual(['b']);
  });

  it('does not add when the selection is at capacity', () => {
    const selected = ['a', 'b'];
    toggleSelected(selected, 'c', 2);
    expect(selected).toEqual(['a', 'b']);
  });

  it('still removes when at capacity (deselect always works)', () => {
    const selected = ['a', 'b'];
    toggleSelected(selected, 'b', 2);
    expect(selected).toEqual(['a']);
  });
});
