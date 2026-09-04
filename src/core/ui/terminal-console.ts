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

import { cyan, green, isTTY, red, yellow } from './colors.ts';
import { note as writeNote } from './components/note.ts';
import { phase as writePhase } from './components/phase.ts';
import {
  confirmPrompt as runConfirmPrompt,
  type MultiSelectOption,
  multiSelectPrompt as runMultiSelectPrompt,
  type MultiSelectPromptOptions,
  passwordPrompt as runPasswordPrompt,
  pressEnterKeyPrompt as runPressEnterKeyPrompt,
  promptUntilValid as runPromptUntilValid,
  type SelectOption,
  selectPrompt as runSelectPrompt,
  textPrompt as runTextPrompt,
} from './components/prompts.ts';
import { intro as writeIntro, outro as writeOutro } from './components/sections.ts';
import { withSpinner as runWithSpinner } from './components/spinner.ts';
import type { Console } from './console.ts';
import { isMockActive, recordCall } from './mock.ts';
import { channelStream, print as writePrint, write } from './streams.ts';
import type { ColorFn, NoteOptions, OutputChannel, PhaseItem, PhaseOptions } from './types.ts';

/**
 * Production {@link Console}: writes to stdout/stderr.
 *
 * Still honors the process-global UI mock (`setMockUi`) so unmigrated unit
 * tests keep working while callers move onto `ctx.console`.
 */
export class TerminalConsole implements Console {
  private formattedOutputMode = false;
  private readonly collectedMessages: string[] = [];

  info(message: string, channel: OutputChannel = 'stdout'): void {
    if (isMockActive()) {
      recordCall('info', message);
      return;
    }
    if (channel === 'stdout' && this.formattedOutputMode) {
      this.collectedMessages.push(`  ℹ  ${message}`);
      return;
    }
    write(channelStream(channel), `  ${cyan('ℹ')}  ${message}`);
  }

  success(message: string): void {
    if (isMockActive()) {
      recordCall('success', message);
      return;
    }
    if (this.formattedOutputMode) {
      this.collectedMessages.push(`✅ ${message}`);
      return;
    }
    write(process.stdout, `✅ ${green(message)}`);
  }

  discreetSuccess(message: string, channel: OutputChannel = 'stdout'): void {
    if (isMockActive()) {
      recordCall('discreetSuccess', message);
      return;
    }
    if (channel === 'stdout' && this.formattedOutputMode) {
      this.collectedMessages.push(`  ✓  ${message}`);
      return;
    }
    write(channelStream(channel), `  ${green('✓')}  ${message}`);
  }

  warn(message: string): void {
    if (isMockActive()) {
      recordCall('warn', message);
      return;
    }
    write(process.stderr, `⚠️ ${yellow(message)}`);
  }

  error(message: string): void {
    if (isMockActive()) {
      recordCall('error', message);
      return;
    }
    write(process.stderr, `❌ ${red(message)}`);
  }

  text(message: string, color?: ColorFn, channel: OutputChannel = 'stdout'): void {
    if (isMockActive()) {
      recordCall('text', message);
      return;
    }
    if (channel === 'stdout' && this.formattedOutputMode) {
      this.collectedMessages.push(message);
      return;
    }
    const formatted = color ? color(message) : message;
    write(channelStream(channel), formatted);
  }

  print(message: string, channel: OutputChannel = 'stdout'): void {
    if (isMockActive()) {
      recordCall('print', message);
      return;
    }
    writePrint(message, channel);
  }

  blank(): void {
    if (isMockActive()) {
      recordCall('blank');
      return;
    }
    if (this.formattedOutputMode) {
      return;
    }
    if (isTTY) {
      process.stdout.write('\n');
    }
  }

  note(content: string | string[], title?: string, opts: NoteOptions = {}): void {
    writeNote(content, title, opts);
  }

  phase(title: string, items: PhaseItem[], opts: PhaseOptions = {}): void {
    writePhase(title, items, opts);
  }

  intro(title: string, subtitle?: string): void {
    writeIntro(title, subtitle);
  }

  outro(message: string, status: 'success' | 'error' = 'success', detail?: string): void {
    writeOutro(message, status, detail);
  }

  withSpinner<T>(
    message: string,
    task: () => Promise<T>,
    channel: OutputChannel = 'stdout',
  ): Promise<T> {
    return runWithSpinner(message, task, channel);
  }

  textPrompt(message: string): Promise<string | null> {
    return runTextPrompt(message);
  }

  passwordPrompt(message: string): Promise<string | null> {
    return runPasswordPrompt(message);
  }

  confirmPrompt(message: string, defaultValue: boolean): Promise<boolean | null> {
    return runConfirmPrompt(message, defaultValue);
  }

  selectPrompt<T>(message: string, options: SelectOption<T>[]): Promise<T | null> {
    return runSelectPrompt(message, options);
  }

  multiSelectPrompt<T>(
    message: string,
    options: MultiSelectOption<T>[],
    loadMoreOpts?: MultiSelectPromptOptions<T>,
  ): Promise<T[] | null> {
    return runMultiSelectPrompt(message, options, loadMoreOpts);
  }

  promptUntilValid(
    message: string,
    isValid: (value: string) => boolean,
    errorMessage: string,
  ): Promise<string | null> {
    return runPromptUntilValid(message, isValid, errorMessage);
  }

  pressEnterKeyPrompt(message: string): Promise<void> {
    return runPressEnterKeyPrompt(message);
  }

  setFormattedOutputMode(active: boolean): void {
    this.formattedOutputMode = active;
    if (!active) {
      this.collectedMessages.length = 0;
    }
  }

  isFormattedOutputMode(): boolean {
    return this.formattedOutputMode;
  }

  getMessagesForFormattedOutput(): string[] {
    return [...this.collectedMessages];
  }
}
