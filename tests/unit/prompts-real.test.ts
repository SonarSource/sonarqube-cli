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

// Tests for prompts non-mock paths: textPrompt, confirmPrompt, pressAnyKeyPrompt
// mock.module replaces @clack/core so no real TTY is needed.
// The mock invokes the render() callback with different states to cover all render branches.

import { describe, it, expect, beforeEach } from 'bun:test';

// Mutable state for controlling what each prompt returns
let mockTextResult: string | symbol = 'default';
let mockConfirmResult: boolean | symbol = true;

void mock.module('@clack/core', () => {
  class TextPromptMock {
    state: string = 'initial';
    value: string = '';
    userInputWithCursor: string = '';
    private _render: () => string | undefined;

    constructor(opts: { render: () => string | undefined }) {
      this._render = opts.render;
    }

    prompt() {
      // Exercise all render states to cover render() branches in prompts.ts
      this.state = 'initial';
      this._render.call(this);
      this.state = 'submit';
      this._render.call(this);
      this.state = 'cancel';
      this._render.call(this);
      return mockTextResult;
    }
  }

  class ConfirmPromptMock {
    state: string = 'initial';
    value: boolean = true;
    cursor: number = 0;
    active: string = 'Yes';
    inactive: string = 'No';
    private _render: () => string;

    constructor(opts: { active: string; inactive: string; render: () => string }) {
      this.active = opts.active;
      this.inactive = opts.inactive;
      this._render = opts.render;
    }

    prompt() {
      // Exercise all render states + both cursor positions
      this.state = 'initial';
      this.cursor = 0;
      this._render.call(this);
      this.state = 'initial';
      this.cursor = 1;
      this._render.call(this);
      this.state = 'submit';
      this.value = true;
      this._render.call(this);
      this.state = 'cancel';
      this._render.call(this);
      return mockConfirmResult;
    }
  }

  return {
    TextPrompt: TextPromptMock,
    ConfirmPrompt: ConfirmPromptMock,
    isCancel: (value: unknown) => typeof value === 'symbol',
  };
});

import { mock } from 'bun:test';
import { textPrompt, confirmPrompt, pressAnyKeyPrompt } from '../../src/ui/components/prompts.js';

// ─── textPrompt non-mock ──────────────────────────────────────────────────────

describe('textPrompt: real prompt path', () => {
  beforeEach(() => {
    mockTextResult = 'default';
  });

  it('returns the string value from prompt', async () => {
    mockTextResult = 'entered-value';
    const result = await textPrompt('Enter name');
    expect(result).toBe('entered-value');
  });

  it('returns null when prompt is cancelled (symbol returned)', async () => {
    mockTextResult = Symbol('cancel');
    const result = await textPrompt('Enter name');
    expect(result).toBeNull();
  });

  it('returns empty string when prompt returns empty string', async () => {
    mockTextResult = '';
    const result = await textPrompt('Enter name');
    expect(result).toBe('');
  });
});

// ─── confirmPrompt non-mock ───────────────────────────────────────────────────

describe('confirmPrompt: real prompt path', () => {
  beforeEach(() => {
    mockConfirmResult = true;
  });

  it('returns true when prompt confirms', async () => {
    mockConfirmResult = true;
    const result = await confirmPrompt('Are you sure?');
    expect(result).toBe(true);
  });

  it('returns false when prompt declines', async () => {
    mockConfirmResult = false;
    const result = await confirmPrompt('Are you sure?');
    expect(result).toBe(false);
  });

  it('returns null when prompt is cancelled (symbol returned)', async () => {
    mockConfirmResult = Symbol('cancel');
    const result = await confirmPrompt('Are you sure?');
    expect(result).toBeNull();
  });
});

// ─── pressAnyKeyPrompt non-mock ────────────────────────────────────────────────

describe('pressAnyKeyPrompt: real prompt path', () => {
  beforeEach(() => {
    mockTextResult = '';
  });

  it('completes without throwing', async () => {
    await pressAnyKeyPrompt('Press any key to continue');
  });
});
