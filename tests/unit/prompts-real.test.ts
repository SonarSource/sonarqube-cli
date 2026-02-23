// Tests for prompts non-mock paths: textPrompt, confirmPrompt, pressEnterPrompt
// mock.module replaces @clack/core so no real TTY is needed.
// The mock invokes the render() callback with different states to cover all render branches.

import { describe, it, expect, beforeEach } from 'bun:test';

// Mutable state for controlling what each prompt returns
let mockTextResult: string | symbol = 'default';
let mockConfirmResult: boolean | symbol = true;

mock.module('@clack/core', () => {
  class TextPromptMock {
    state: string = 'initial';
    value: string = '';
    userInputWithCursor: string = '';
    private _render: () => string | undefined;

    constructor(opts: { render: () => string | undefined }) {
      this._render = opts.render;
    }

    async prompt() {
      // Exercise all render states to cover render() branches in prompts.ts
      this.state = 'initial'; this._render.call(this);
      this.state = 'submit';  this._render.call(this);
      this.state = 'cancel';  this._render.call(this);
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

    async prompt() {
      // Exercise all render states + both cursor positions
      this.state = 'initial'; this.cursor = 0; this._render.call(this);
      this.state = 'initial'; this.cursor = 1; this._render.call(this);
      this.state = 'submit';  this.value = true;  this._render.call(this);
      this.state = 'cancel';  this._render.call(this);
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
import { textPrompt, confirmPrompt, pressEnterPrompt } from '../../src/ui/components/prompts.js';

// ─── textPrompt non-mock ──────────────────────────────────────────────────────

describe('textPrompt: real prompt path', () => {
  beforeEach(() => { mockTextResult = 'default'; });

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
  beforeEach(() => { mockConfirmResult = true; });

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

// ─── pressEnterPrompt non-mock ────────────────────────────────────────────────

describe('pressEnterPrompt: real prompt path', () => {
  beforeEach(() => { mockTextResult = ''; });

  it('completes without throwing', async () => {
    await expect(pressEnterPrompt('Press Enter to continue')).resolves.toBeUndefined();
  });
});
