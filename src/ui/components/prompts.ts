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

// Interactive prompts - text input, confirmation, press-to-continue

import { ConfirmPrompt, isCancel, Prompt, SelectPrompt, TextPrompt } from '@clack/core';

import { cyan, dim, green, red } from '../colors.js';
import { print } from '../messages.js';
import { dequeueMockResponse, isMockActive, recordCall } from '../mock.js';

const CTRL_C = 0x03;
const ENTER_CR = 0x0d;
const ENTER_LF = 0x0a;
const EXIT_CODE_SIGINT = 130;

/**
 * Text input prompt. Returns null if cancelled (Ctrl+C).
 */
export async function textPrompt(message: string): Promise<string | null> {
  if (isMockActive()) {
    const value = dequeueMockResponse<string>('');
    recordCall('textPrompt', message, value);
    return value;
  }

  const prompt = new TextPrompt({
    render() {
      if (this.state === 'submit') return `  ${green('✓')}  ${message} ${dim(this.value ?? '')}`;
      if (this.state === 'cancel') return `  ${red('✗')}  ${message}`;
      return [`  ${cyan('?')}  ${message}`, `  ${dim('›')} ${this.userInputWithCursor}`].join('\n');
    },
  });

  const result = await prompt.prompt();
  if (isCancel(result)) return null;
  return result ?? null;
}

/**
 * Yes/No confirmation prompt. Returns null if cancelled (Ctrl+C).
 */
export async function confirmPrompt(message: string): Promise<boolean | null> {
  if (isMockActive()) {
    const value = dequeueMockResponse<boolean>(false);
    recordCall('confirmPrompt', message, value);
    return value;
  }

  const prompt = new ConfirmPrompt({
    active: 'Yes',
    inactive: 'No',
    render() {
      if (this.state === 'submit')
        return `  ${green('✓')}  ${message} ${dim(this.value ? 'Yes' : 'No')}`;
      if (this.state === 'cancel') return `  ${red('✗')}  ${message}`;
      const yes = this.cursor === 0 ? cyan('[Yes]') : ' Yes ';
      const no = this.cursor === 1 ? cyan('[No] ') : ' No  ';
      return `  ${cyan('?')}  ${message}  ${yes} / ${no}`;
    },
  });

  const result = await prompt.prompt();
  if (isCancel(result)) return null;
  return result ?? null;
}

export interface SelectOption<T> {
  value: T;
  label: string;
}

/**
 * Selection prompt. Returns null if cancelled (Ctrl+C).
 */
export async function selectPrompt<T>(
  message: string,
  options: SelectOption<T>[],
): Promise<T | null> {
  if (isMockActive()) {
    const value = dequeueMockResponse<T | null>(options.length ? options[0].value : null);
    recordCall('selectPrompt', message, value);
    return value;
  }

  const prompt = new SelectPrompt({
    options,
    render() {
      if (this.state === 'submit') {
        const selected = options.find((o) => o.value === this.value);
        return `  ${green('✓')}  ${message} ${dim(selected?.label ?? String(this.value))}`;
      }
      if (this.state === 'cancel') return `  ${red('✗')}  ${message}`;
      const lines = [`  ${cyan('?')}  ${message}`];
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const selected = i === this.cursor;
        lines.push(`    ${selected ? cyan('›') : ' '} ${selected ? opt.label : dim(opt.label)}`);
      }
      return lines.join('\n');
    },
  });

  const result = await prompt.prompt();
  if (isCancel(result)) return null;
  return result as T;
}

export interface MultiSelectOption<T> {
  value: T;
  label: string;
}

const MULTISELECT_VIEWPORT_SIZE = 12;
const MULTISELECT_MAX_SELECTED = 20;

export function calculateViewport(
  cursor: number,
  total: number,
  viewportSize: number,
): { start: number; end: number } {
  const start = Math.min(
    Math.max(0, cursor - Math.floor(viewportSize / 2)),
    Math.max(0, total - viewportSize),
  );
  const end = Math.min(start + viewportSize, total);
  return { start, end };
}

export function toggleSelected<T>(selected: T[], val: T, max: number): void {
  const idx = selected.indexOf(val);
  if (idx >= 0) {
    selected.splice(idx, 1);
  } else if (selected.length < max) {
    selected.push(val);
  }
}

/**
 * Multi-select prompt. Space to toggle, Enter to confirm. Max 20 selections.
 * Returns the selected values array (may be empty) or null if cancelled (Ctrl+C or q).
 * Renders a scrolling viewport when the option list exceeds MULTISELECT_VIEWPORT_SIZE.
 */
export async function multiSelectPrompt<T>(
  message: string,
  options: MultiSelectOption<T>[],
): Promise<T[] | null> {
  if (isMockActive()) {
    const value = dequeueMockResponse<T[] | null>([]);
    recordCall('multiSelectPrompt', message, value);
    return value;
  }

  const selected: T[] = [];
  let cursor = 0;

  const prompt = new Prompt<T[]>(
    {
      render() {
        if (this.state === 'submit') {
          const selectedLabel = `${selected.length} selected`;
          return `  ${green('✓')}  ${message} ${dim(selectedLabel)}`;
        }
        if (this.state === 'cancel') {
          return `  ${red('✗')}  ${message}`;
        }

        const atCap = selected.length >= MULTISELECT_MAX_SELECTED;
        const hint = atCap
          ? dim(
              `(${MULTISELECT_MAX_SELECTED}/${MULTISELECT_MAX_SELECTED} - deselect to choose others)`,
            )
          : dim('(Space to toggle, Enter to confirm, q to quit)');

        const total = options.length;
        const { start, end } = calculateViewport(cursor, total, MULTISELECT_VIEWPORT_SIZE);

        const lines = [`  ${cyan('?')}  ${message}  ${hint}`];

        if (start > 0) {
          const more = `↑ ${start} more`;
          lines.push(`      ${dim(more)}`);
        }

        for (let i = start; i < end; i++) {
          const opt = options[i];
          const isCursor = i === cursor;
          const isSelected = selected.includes(opt.value);
          const unavailable = atCap && !isSelected;
          const checkbox = checkboxComponent(isSelected, unavailable);
          const arrow = isCursor ? cyan('❯') : ' ';
          const label = isCursor && !unavailable ? opt.label : dim(opt.label);
          lines.push(`    ${arrow} ${checkbox}  ${label}`);
        }

        const more = `↓ ${total - end} more`;
        if (end < total) lines.push(`      ${dim(more)}`);

        return lines.join('\n');
      },
    },
    false,
  );

  prompt.on('cursor', (dir) => {
    if (dir === 'up') cursor = Math.max(0, cursor - 1);
    else if (dir === 'down') cursor = Math.min(options.length - 1, cursor + 1);
    else if (dir === 'space') {
      const val = options[cursor]?.value;
      if (val !== undefined) {
        toggleSelected(selected, val, MULTISELECT_MAX_SELECTED);
      }
    }
  });

  prompt.on('key', (_key, s) => {
    if (s.name === 'return') {
      prompt.value = [...selected];
    } else if (s.name === 'q') {
      prompt.state = 'cancel';
    }
  });

  const result = await prompt.prompt();
  if (isCancel(result)) return null;
  return result ?? [];
}

export function checkboxComponent(isSelected: boolean, unavailable: boolean): string {
  if (isSelected) {
    return cyan('◉');
  }

  if (unavailable) {
    return dim('◯');
  }

  return '◯';
}

/**
 * Calls textPrompt in a loop until isValid returns true, printing errorMessage on each invalid
 * attempt. Returns null if the user cancels (Ctrl+C).
 */
export async function promptUntilValid(
  message: string,
  isValid: (value: string) => boolean,
  errorMessage: string,
): Promise<string | null> {
  for (;;) {
    const value = await textPrompt(message);
    if (value === null) {
      return null;
    }
    if (isValid(value)) {
      return value;
    }
    print(errorMessage);
  }
}

/**
 * Press-Enter-to-continue prompt using raw stdin.
 * Only Enter advances the prompt; all other keys are silently consumed.
 * Skipped automatically in mock mode, CI=true, or non-TTY environments.
 */
export async function pressEnterKeyPrompt(message: string): Promise<void> {
  if (isMockActive() || process.env.CI === 'true') {
    if (isMockActive()) recordCall('pressAnyKeyPrompt', message);
    return;
  }

  if (!process.stdin.isTTY) return;

  process.stdout.write(`  ${dim('›')}  ${message}`);

  return new Promise<void>((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const onData = (chunk: Buffer): void => {
      const byte = chunk[0];
      if (byte === CTRL_C) {
        // Ctrl+C
        cleanup();
        process.stdout.write('\n');
        process.exit(EXIT_CODE_SIGINT);
      }
      if (byte === ENTER_CR || byte === ENTER_LF) {
        // Enter (CR or LF)
        cleanup();
        process.stdout.write('\n');
        resolve();
      }
      // All other keys: silently consumed
    };

    function cleanup(): void {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    process.stdin.on('data', onData);
  });
}
