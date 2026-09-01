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

import type { CliConsole } from '@/core/ui/cli-console.ts';
import type {
  MultiSelectOption,
  MultiSelectPromptOptions,
  SelectOption,
} from '@/core/ui/components/prompts.ts';
import type {
  ColorFn,
  NoteOptions,
  OutputChannel,
  PhaseItem,
  PhaseOptions,
} from '@/core/ui/types.ts';

export interface UiCall {
  method: string;
  args: unknown[];
}

/**
 * Test double for {@link CliConsole}. Records calls and returns queued prompt answers.
 * Never writes to stdout/stderr.
 */
export class FakeConsole implements CliConsole {
  readonly calls: UiCall[] = [];
  private readonly responses: unknown[] = [];

  /** Record a call under an arbitrary method name (progress widgets, etc.). */
  record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  queueResponse(value: unknown): void {
    this.responses.push(value);
  }

  private dequeue<T>(fallback: T): T {
    if (this.responses.length > 0) {
      return this.responses.shift() as T;
    }
    return fallback;
  }

  findCall(method: string, substring: string): UiCall | undefined {
    return this.calls.find(
      (c) => c.method === method && typeof c.args[0] === 'string' && c.args[0].includes(substring),
    );
  }

  info(message: string, _channel?: OutputChannel): void {
    this.record('info', message);
  }

  success(message: string): void {
    this.record('success', message);
  }

  discreetSuccess(message: string, _channel?: OutputChannel): void {
    this.record('discreetSuccess', message);
  }

  warn(message: string): void {
    this.record('warn', message);
  }

  error(message: string): void {
    this.record('error', message);
  }

  text(message: string, _color?: ColorFn, _channel?: OutputChannel): void {
    this.record('text', message);
  }

  print(message: string, _channel?: OutputChannel): void {
    this.record('print', message);
  }

  blank(): void {
    this.record('blank');
  }

  note(content: string | string[], title?: string, _opts?: NoteOptions): void {
    this.record('note', content, title);
  }

  phase(title: string, items: PhaseItem[], _opts?: PhaseOptions): void {
    this.record('phase', title, items);
  }

  intro(title: string, subtitle?: string): void {
    this.record('intro', title, subtitle);
  }

  outro(message: string, status?: 'success' | 'error', detail?: string): void {
    this.record('outro', message, status, detail);
  }

  async withSpinner<T>(
    message: string,
    task: () => Promise<T>,
    _channel?: OutputChannel,
  ): Promise<T> {
    this.record('spinner', message);
    return await task();
  }

  textPrompt(message: string): Promise<string | null> {
    const value = this.dequeue<string>('');
    this.record('textPrompt', message, value);
    return Promise.resolve(value);
  }

  passwordPrompt(message: string): Promise<string | null> {
    const value = this.dequeue<string>('');
    this.record('passwordPrompt', message, value);
    return Promise.resolve(value);
  }

  confirmPrompt(message: string, defaultValue: boolean): Promise<boolean | null> {
    const value = this.dequeue<boolean>(defaultValue);
    this.record('confirmPrompt', message, value);
    return Promise.resolve(value);
  }

  selectPrompt<T>(message: string, options: SelectOption<T>[]): Promise<T | null> {
    const value = this.dequeue<T | null>(options.length ? options[0].value : null);
    this.record('selectPrompt', message, value);
    return Promise.resolve(value);
  }

  multiSelectPrompt<T>(
    message: string,
    _options: MultiSelectOption<T>[],
    _loadMoreOpts?: MultiSelectPromptOptions<T>,
  ): Promise<T[] | null> {
    const value = this.dequeue<T[] | null>([]);
    this.record('multiSelectPrompt', message, value);
    return Promise.resolve(value);
  }

  async promptUntilValid(
    message: string,
    isValid: (value: string) => boolean,
    errorMessage: string,
  ): Promise<string | null> {
    for (;;) {
      const value = await this.textPrompt(message);
      if (value === null) {
        return null;
      }
      if (isValid(value)) {
        return value;
      }
      this.print(errorMessage);
    }
  }

  pressEnterKeyPrompt(message: string): Promise<void> {
    this.record('pressAnyKeyPrompt', message);
    return Promise.resolve();
  }

  setFormattedOutputMode(_active: boolean): void {}

  isFormattedOutputMode(): boolean {
    return false;
  }

  getMessagesForFormattedOutput(): string[] {
    return [];
  }
}
