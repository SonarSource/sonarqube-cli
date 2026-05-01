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
 * - mock mode: dequeues responses in order, records calls
 * - CI=true: pressAnyKeyPrompt skips without recording
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { confirmPrompt, multiSelectPrompt, pressEnterKeyPrompt, textPrompt } from '../../../src/ui';
import {
  clearMockResponses,
  clearMockUiCalls,
  getMockUiCalls,
  queueMockResponse,
  setMockUi,
} from '../../../src/ui';
import {
  calculateViewport,
  checkboxComponent,
  toggleSelected,
} from '../../../src/ui/components/prompts';

// ─── textPrompt ───────────────────────────────────────────────────────────────

describe('textPrompt: mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('returns queued string response and records call', async () => {
    queueMockResponse('my-org');
    const result = await textPrompt('Enter organization');
    expect(result).toBe('my-org');
    const calls = getMockUiCalls();
    expect(calls.some((c) => c.method === 'textPrompt' && c.args[0] === 'Enter organization')).toBe(
      true,
    );
  });

  it('returns empty string fallback when queue is empty', async () => {
    const result = await textPrompt('Enter value');
    expect(result).toBe('');
  });

  it('dequeues responses in FIFO order', async () => {
    queueMockResponse('first');
    queueMockResponse('second');
    const r1 = await textPrompt('Prompt 1');
    const r2 = await textPrompt('Prompt 2');
    expect(r1).toBe('first');
    expect(r2).toBe('second');
  });

  it('records each call with its message', async () => {
    await textPrompt('Message A');
    await textPrompt('Message B');
    const calls = getMockUiCalls().filter((c) => c.method === 'textPrompt');
    expect(calls.map((c) => c.args[0])).toEqual(['Message A', 'Message B']);
  });
});

// ─── confirmPrompt ────────────────────────────────────────────────────────────

describe('confirmPrompt: mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('returns queued true response and records call', async () => {
    queueMockResponse(true);
    const result = await confirmPrompt('Are you sure?');
    expect(result).toBe(true);
    const calls = getMockUiCalls();
    expect(calls.some((c) => c.method === 'confirmPrompt' && c.args[0] === 'Are you sure?')).toBe(
      true,
    );
  });

  it('returns queued false response', async () => {
    queueMockResponse(false);
    const result = await confirmPrompt('Proceed?');
    expect(result).toBe(false);
  });

  it('returns false as fallback when queue is empty', async () => {
    const result = await confirmPrompt('Delete everything?');
    expect(result).toBe(false);
  });

  it('dequeues boolean responses in FIFO order', async () => {
    queueMockResponse(true);
    queueMockResponse(false);
    expect(await confirmPrompt('First?')).toBe(true);
    expect(await confirmPrompt('Second?')).toBe(false);
  });
});

// ─── clearMockResponses ───────────────────────────────────────────────────────

describe('clearMockResponses', () => {
  it('removes all queued responses so next call returns fallback', async () => {
    setMockUi(true);
    clearMockUiCalls();
    try {
      queueMockResponse('queued');
      clearMockResponses();
      const result = await textPrompt('After clear');
      expect(result).toBe('');
    } finally {
      setMockUi(false);
    }
  });
});

// ─── pressAnyKeyPrompt ─────────────────────────────────────────────────────────

describe('pressAnyKeyPrompt', () => {
  it('records call in mock mode', async () => {
    setMockUi(true);
    clearMockUiCalls();
    try {
      await pressEnterKeyPrompt('Press Enter to continue');
      const calls = getMockUiCalls();
      expect(
        calls.some(
          (c) => c.method === 'pressAnyKeyPrompt' && c.args[0] === 'Press Enter to continue',
        ),
      ).toBe(true);
    } finally {
      setMockUi(false);
    }
  });

  it('returns without recording when CI=true and mock is inactive', async () => {
    const savedCI = process.env['CI'];
    process.env['CI'] = 'true';
    clearMockUiCalls();
    try {
      await pressEnterKeyPrompt('Press Enter');
      const calls = getMockUiCalls().filter((c) => c.method === 'pressAnyKeyPrompt');
      expect(calls).toHaveLength(0);
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

describe('multiSelectPrompt: mock mode', () => {
  beforeEach(() => {
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
  });

  it('returns empty array fallback when queue is empty', async () => {
    const result = await multiSelectPrompt('Pick options', [{ value: 'a', label: 'A' }]);
    expect(result).toEqual([]);
  });

  it('returns queued array of values', async () => {
    queueMockResponse(['x', 'y']);
    const result = await multiSelectPrompt('Pick options', [
      { value: 'x', label: 'X' },
      { value: 'y', label: 'Y' },
    ]);
    expect(result).toEqual(['x', 'y']);
  });

  it('records call with message and queued value', async () => {
    queueMockResponse(['a']);
    await multiSelectPrompt('Choose items', [{ value: 'a', label: 'A' }]);
    const calls = getMockUiCalls();
    expect(
      calls.some((c) => c.method === 'multiSelectPrompt' && c.args[0] === 'Choose items'),
    ).toBe(true);
  });

  it('dequeues responses in FIFO order', async () => {
    queueMockResponse(['first']);
    queueMockResponse(['second']);
    const r1 = await multiSelectPrompt('First prompt', [{ value: 'first', label: 'First' }]);
    const r2 = await multiSelectPrompt('Second prompt', [{ value: 'second', label: 'Second' }]);
    expect(r1).toEqual(['first']);
    expect(r2).toEqual(['second']);
  });

  it('returns null when null is queued', async () => {
    queueMockResponse(null);
    const result = await multiSelectPrompt('Pick options', [{ value: 'a', label: 'A' }]);
    expect(result).toBeNull();
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
