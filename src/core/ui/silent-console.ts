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
  SearchPromptOptions,
  SelectOption,
} from './console.ts';
import type { TreePromptOptions } from './tree/tree-source.ts';

/** Console for background work that must not write to terminal streams or read stdin. */
export class SilentConsole implements Console {
  canPrompt(): boolean {
    return false;
  }

  private suppress(method: string, ...args: unknown[]): void {
    logger.debug(`[silent] ${method}`, ...args.filter((arg) => arg != null && arg !== ''));
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
    logger.warn(message);
  }

  error(message: string): void {
    logger.error(message);
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

  withSpinner<T>(message: string, task: () => Promise<T>, _channel?: OutputChannel): Promise<T> {
    this.suppress('withSpinner', message);
    return task();
  }

  textPrompt(_message: string): Promise<string | null> {
    return Promise.resolve(null);
  }

  passwordPrompt(_message: string): Promise<string | null> {
    return Promise.resolve(null);
  }

  confirmPrompt(_message: string, _defaultValue: boolean): Promise<boolean | null> {
    return Promise.resolve(null);
  }

  selectPrompt<T>(_message: string, _options: SelectOption<T>[]): Promise<T | null> {
    return Promise.resolve(null);
  }

  searchPrompt<T>(_message: string, _options: SearchPromptOptions<T>): Promise<T | null> {
    return Promise.resolve(null);
  }

  treePrompt<T>(_message: string, _options: TreePromptOptions<T>): Promise<T | null> {
    return Promise.resolve(null);
  }

  treeMultiSelectPrompt<T>(_message: string, _options: TreePromptOptions<T>): Promise<T[] | null> {
    return Promise.resolve(null);
  }

  multiSelectPrompt<T>(
    _message: string,
    _options: MultiSelectOption<T>[],
    _loadMoreOpts?: MultiSelectPromptOptions<T>,
  ): Promise<T[] | null> {
    return Promise.resolve(null);
  }

  promptUntilValid(
    _message: string,
    _isValid: (value: string) => boolean,
    _errorMessage: string,
  ): Promise<string | null> {
    return Promise.resolve(null);
  }

  pressEnterKeyPrompt(_message: string): Promise<void> {
    return Promise.resolve();
  }

  // Background messages must never become part of a formatted command response.
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
