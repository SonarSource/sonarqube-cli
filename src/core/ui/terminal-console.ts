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
import { renderNote } from './components/note.ts';
import { renderPhase } from './components/phase.ts';
import {
  type MultiSelectOption,
  type MultiSelectPromptOptions,
  renderConfirmPrompt,
  renderMultiSelectPrompt,
  renderPasswordPrompt,
  renderPressEnterKeyPrompt,
  renderPromptUntilValid,
  renderSelectPrompt,
  renderTextPrompt,
  type SelectOption,
} from './components/prompts.ts';
import { renderIntro, renderOutro } from './components/sections.ts';
import { renderWithSpinner } from './components/spinner.ts';
import type { Console } from './console.ts';
import type { ColorFn, NoteOptions, OutputChannel, PhaseItem, PhaseOptions } from './types.ts';

function write(stream: NodeJS.WriteStream, line: string): void {
  stream.write(line + '\n');
}

function channelStream(channel: OutputChannel): NodeJS.WriteStream {
  return channel === 'stderr' ? process.stderr : process.stdout;
}

/** Production {@link Console}: writes to stdout/stderr. */
export class TerminalConsole implements Console {
  private formattedOutputMode = false;
  private readonly collectedMessages: string[] = [];

  info(message: string, channel: OutputChannel = 'stdout'): void {
    if (channel === 'stdout' && this.formattedOutputMode) {
      this.collectedMessages.push(`  ℹ  ${message}`);
      return;
    }
    write(channelStream(channel), `  ${cyan('ℹ')}  ${message}`);
  }

  success(message: string): void {
    if (this.formattedOutputMode) {
      this.collectedMessages.push(`✅ ${message}`);
      return;
    }
    write(process.stdout, `✅ ${green(message)}`);
  }

  discreetSuccess(message: string, channel: OutputChannel = 'stdout'): void {
    if (channel === 'stdout' && this.formattedOutputMode) {
      this.collectedMessages.push(`  ✓  ${message}`);
      return;
    }
    write(channelStream(channel), `  ${green('✓')}  ${message}`);
  }

  warn(message: string): void {
    write(process.stderr, `⚠️ ${yellow(message)}`);
  }

  error(message: string): void {
    write(process.stderr, `❌ ${red(message)}`);
  }

  text(message: string, color?: ColorFn, channel: OutputChannel = 'stdout'): void {
    if (channel === 'stdout' && this.formattedOutputMode) {
      this.collectedMessages.push(message);
      return;
    }
    const formatted = color ? color(message) : message;
    write(channelStream(channel), formatted);
  }

  print(message: string, channel: OutputChannel = 'stdout'): void {
    channelStream(channel).write(message + (message.endsWith('\n') ? '' : '\n'));
  }

  blank(): void {
    if (this.formattedOutputMode) {
      return;
    }
    if (isTTY) {
      process.stdout.write('\n');
    }
  }

  note(content: string | string[], title?: string, opts: NoteOptions = {}): void {
    renderNote(content, title, opts);
  }

  phase(title: string, items: PhaseItem[], opts: PhaseOptions = {}): void {
    renderPhase(title, items, opts);
  }

  intro(title: string, subtitle?: string): void {
    renderIntro(title, subtitle);
  }

  outro(message: string, status: 'success' | 'error' = 'success', detail?: string): void {
    renderOutro(message, status, detail);
  }

  withSpinner<T>(
    message: string,
    task: () => Promise<T>,
    channel: OutputChannel = 'stdout',
  ): Promise<T> {
    return renderWithSpinner(message, task, channel);
  }

  textPrompt(message: string): Promise<string | null> {
    return renderTextPrompt(message);
  }

  passwordPrompt(message: string): Promise<string | null> {
    return renderPasswordPrompt(message);
  }

  confirmPrompt(message: string, defaultValue: boolean): Promise<boolean | null> {
    return renderConfirmPrompt(message, defaultValue);
  }

  selectPrompt<T>(message: string, options: SelectOption<T>[]): Promise<T | null> {
    return renderSelectPrompt(message, options);
  }

  multiSelectPrompt<T>(
    message: string,
    options: MultiSelectOption<T>[],
    loadMoreOpts?: MultiSelectPromptOptions<T>,
  ): Promise<T[] | null> {
    return renderMultiSelectPrompt(message, options, loadMoreOpts);
  }

  promptUntilValid(
    message: string,
    isValid: (value: string) => boolean,
    errorMessage: string,
  ): Promise<string | null> {
    return renderPromptUntilValid(message, isValid, errorMessage, this);
  }

  pressEnterKeyPrompt(message: string): Promise<void> {
    return renderPressEnterKeyPrompt(message);
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
