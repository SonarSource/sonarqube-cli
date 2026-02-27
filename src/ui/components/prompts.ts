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

// Interactive prompts — text input, confirmation, press-to-continue

import { TextPrompt, ConfirmPrompt, isCancel } from '@clack/core';
import { cyan, green, red, dim } from '../colors.js';
import { isMockActive, recordCall, dequeueMockResponse } from '../mock.js';

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
  return result!;
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
  return result!;
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
        return;
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
