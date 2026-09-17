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

import logger from '@/core/observability/logger.ts';

import type { ColorFn, NoteOptions } from './colors.ts';
import type {
  Console,
  MultiSelectOption,
  MultiSelectPromptOptions,
  OutputChannel,
  PhaseItem,
  PhaseOptions,
  SelectOption,
} from './console.ts';

/**
 * {@link Console} that keeps output to a minimum: informational messages go to the log file
 * instead of the terminal. Used by the post-update integration migration, which reinstalls
 * integrations while the user is running some unrelated command and must not print a full
 * `sonar integrate` transcript over it.
 *
 * Warnings, errors, prompts and spinners still print as normal through the wrapped console.
 */
export class QuietConsole implements Console {
  constructor(private readonly delegate: Console) {}

  private suppress(method: string, ...args: unknown[]): void {
    logger.debug(`[quiet] ${method}`, ...args.filter((arg) => arg != null && arg !== ''));
  }

  info(message: string, _channel?: OutputChannel): void {
    this.suppress('info', message);
  }

  success(message: string): void {
    this.suppress('success', message);
  }

  discreetSuccess(message: string, _channel?: OutputChannel): void {
    this.suppress('discreetSuccess', message);
  }

  warn(message: string): void {
    this.delegate.warn(message);
  }

  error(message: string): void {
    this.delegate.error(message);
  }

  text(message: string, _color?: ColorFn, _channel?: OutputChannel): void {
    this.suppress('text', message);
  }

  print(message: string, _channel?: OutputChannel): void {
    this.suppress('print', message);
  }

  blank(): void {
    this.suppress('blank');
  }

  note(content: string | string[], title?: string, _opts?: NoteOptions): void {
    const lines = Array.isArray(content) ? content : content.split('\n');
    this.suppress('note', title, lines.join(' | '));
  }

  phase(title: string, items: PhaseItem[], _opts?: PhaseOptions): void {
    const rendered = items.map((item) => `${item.text} [${item.status}]`).join(' | ');
    this.suppress('phase', title, rendered);
  }

  intro(title: string, subtitle?: string): void {
    this.suppress('intro', title, subtitle);
  }

  outro(message: string, status?: 'success' | 'error', detail?: string): void {
    this.suppress('outro', message, status, detail);
  }

  withSpinner<T>(message: string, task: () => Promise<T>, channel?: OutputChannel): Promise<T> {
    return this.delegate.withSpinner(message, task, channel);
  }

  textPrompt(message: string): Promise<string | null> {
    return this.delegate.textPrompt(message);
  }

  passwordPrompt(message: string): Promise<string | null> {
    return this.delegate.passwordPrompt(message);
  }

  confirmPrompt(message: string, defaultValue: boolean): Promise<boolean | null> {
    return this.delegate.confirmPrompt(message, defaultValue);
  }

  selectPrompt<T>(message: string, options: SelectOption<T>[]): Promise<T | null> {
    return this.delegate.selectPrompt(message, options);
  }

  multiSelectPrompt<T>(
    message: string,
    options: MultiSelectOption<T>[],
    loadMoreOpts?: MultiSelectPromptOptions<T>,
  ): Promise<T[] | null> {
    return this.delegate.multiSelectPrompt(message, options, loadMoreOpts);
  }

  promptUntilValid(
    message: string,
    isValid: (value: string) => boolean,
    errorMessage: string,
  ): Promise<string | null> {
    return this.delegate.promptUntilValid(message, isValid, errorMessage);
  }

  pressEnterKeyPrompt(message: string): Promise<void> {
    return this.delegate.pressEnterKeyPrompt(message);
  }

  /**
   * Deliberately not delegated: toggling would flip the wrapped console's mode, and collecting
   * would leak background messages into a `--format json` payload.
   */
  setFormattedOutputMode(active: boolean): void {
    this.suppress('setFormattedOutputMode', active);
  }

  isFormattedOutputMode(): boolean {
    return false;
  }

  getMessagesForFormattedOutput(): string[] {
    return [];
  }
}
