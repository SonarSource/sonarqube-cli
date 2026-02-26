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
 * Tests for textPrompt, confirmPrompt, pressAnyKeyPrompt:
 * - mock mode: dequeues responses in order, records calls
 * - CI=true: pressAnyKeyPrompt skips without recording
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { textPrompt, confirmPrompt, pressAnyKeyPrompt } from '../../src/ui/components/prompts.js';
import {
  setMockUi,
  getMockUiCalls,
  clearMockUiCalls,
  clearMockResponses,
  queueMockResponse,
} from '../../src/ui/mock.js';

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
      await pressAnyKeyPrompt('Press Enter to continue');
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
      await pressAnyKeyPrompt('Press Enter');
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
