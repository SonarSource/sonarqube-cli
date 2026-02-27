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

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

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
import { textPrompt, confirmPrompt, pressEnterKeyPrompt } from '../../src/ui/components/prompts.js';

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

// ─── pressEnterKeyPrompt TTY ──────────────────────────────────────────────────

describe('pressEnterKeyPrompt: TTY path', () => {
  let mockExit: ReturnType<typeof spyOn>;
  let setRawModeSpy: ReturnType<typeof spyOn>;
  let resumeSpy: ReturnType<typeof spyOn>;
  let pauseSpy: ReturnType<typeof spyOn>;
  let writeSpy: ReturnType<typeof spyOn>;
  let originalCI: string | undefined;

  beforeEach(() => {
    originalCI = process.env.CI;
    delete process.env.CI;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    if (!(process.stdin as NodeJS.ReadStream).setRawMode) {
      (process.stdin as NodeJS.ReadStream).setRawMode = () => process.stdin as NodeJS.ReadStream;
    }
    setRawModeSpy = spyOn(process.stdin as NodeJS.ReadStream, 'setRawMode').mockReturnValue(
      process.stdin as NodeJS.ReadStream,
    );
    resumeSpy = spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    pauseSpy = spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    writeSpy = spyOn(process.stdout, 'write').mockReturnValue(true);
    mockExit = spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    if (originalCI === undefined) delete process.env.CI;
    else process.env.CI = originalCI;
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    setRawModeSpy.mockRestore();
    resumeSpy.mockRestore();
    pauseSpy.mockRestore();
    writeSpy.mockRestore();
    mockExit.mockRestore();
  });

  it('writes prompt message and enables raw mode', async () => {
    setTimeout(() => process.stdin.emit('data', Buffer.from([0x0d])), 0);
    await pressEnterKeyPrompt('Press Enter');
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Press Enter'));
    expect(setRawModeSpy).toHaveBeenCalledWith(true);
    expect(setRawModeSpy).toHaveBeenCalledWith(false);
  });

  it('resolves when Enter (CR 0x0d) is pressed', async () => {
    setTimeout(() => process.stdin.emit('data', Buffer.from([0x0d])), 0);
    await pressEnterKeyPrompt('Press Enter');
  });

  it('resolves when Enter (LF 0x0a) is pressed', async () => {
    setTimeout(() => process.stdin.emit('data', Buffer.from([0x0a])), 0);
    await pressEnterKeyPrompt('Press Enter');
  });

  it('ignores non-Enter keys and resolves only on Enter', async () => {
    setTimeout(() => {
      process.stdin.emit('data', Buffer.from([0x41])); // 'a' — ignored
      process.stdin.emit('data', Buffer.from([0x1b])); // Escape — ignored
      process.stdin.emit('data', Buffer.from([0x0d])); // Enter — resolves
    }, 0);
    await pressEnterKeyPrompt('Press Enter');
  });

  it('calls process.exit(130) on Ctrl+C', async () => {
    // Start the prompt (don't await — it won't resolve when exit is mocked as no-op)
    const promptPromise = pressEnterKeyPrompt('Press Enter');
    setTimeout(() => process.stdin.emit('data', Buffer.from([0x03])), 0);
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(mockExit).toHaveBeenCalledWith(130);
    // Prevent unhandled rejection warnings for the dangling promise
    promptPromise.catch(() => undefined);
  });
});
