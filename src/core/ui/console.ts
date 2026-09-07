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

import type {
  MultiSelectOption,
  MultiSelectPromptOptions,
  SelectOption,
} from './components/prompts.ts';
import type { ColorFn, NoteOptions, OutputChannel, PhaseItem, PhaseOptions } from './types.ts';

/**
 * Human-facing terminal I/O for the CLI (messages, notes, prompts, spinners).
 *
 * Production uses `TerminalConsole`. Unit tests inject `FakeConsole`.
 * Not Node's global `console`.
 *
 * Protocol JSON written by agent hooks (`process.stdout.write`) is out of scope.
 */
export interface Console {
  /**
   * Informational line with a cyan `ℹ` prefix.
   * Defaults to stdout. On stdout, participates in formatted-output buffering
   * (`setFormattedOutputMode`); stderr always writes through.
   */
  info(message: string, channel?: OutputChannel): void;

  /**
   * Prominent success on stdout with a green `✅` prefix.
   * Prefer {@link discreetSuccess} for quieter in-flow confirmations.
   * Participates in formatted-output buffering.
   */
  success(message: string): void;

  /**
   * Quiet success with a green `✓` prefix (less emphasis than {@link success}).
   * Defaults to stdout. On stdout, participates in formatted-output buffering;
   * stderr always writes through.
   */
  discreetSuccess(message: string, channel?: OutputChannel): void;

  /**
   * Warning on stderr with a yellow `⚠️` prefix.
   * Never buffered for formatted output.
   */
  warn(message: string): void;

  /**
   * Error on stderr with a red `❌` prefix.
   * Never buffered for formatted output.
   */
  error(message: string): void;

  /**
   * Human-readable line with no semantic icon. Optional color (TTY only).
   * Defaults to stdout. On stdout, participates in formatted-output buffering;
   * stderr always writes through.
   */
  text(message: string, color?: ColorFn, channel?: OutputChannel): void;

  /**
   * Raw line with no color or prefix — safe for piping.
   * Does not participate in formatted-output buffering.
   */
  print(message: string, channel?: OutputChannel): void;

  /**
   * Blank line separator. No-op in formatted-output mode and when stdout is not a TTY.
   */
  blank(): void;

  /**
   * Boxed note on stdout (TTY) or `[title]` plus lines (non-TTY).
   */
  note(content: string | string[], title?: string, opts?: NoteOptions): void;

  /**
   * Multi-step status list on stdout. TTY uses colored icons; non-TTY uses plain icons.
   */
  phase(title: string, items: PhaseItem[], opts?: PhaseOptions): void;

  /**
   * Command opening divider on stdout.
   */
  intro(title: string, subtitle?: string): void;

  /**
   * Command closing divider on stdout. `status` chooses ✅ vs ❌.
   */
  outro(message: string, status?: 'success' | 'error', detail?: string): void;

  /**
   * Run `task` with an animated spinner (TTY) or a `message...` line (non-TTY).
   * Shows ✓ on success and ✗ on failure. Defaults to stdout.
   */
  withSpinner<T>(message: string, task: () => Promise<T>, channel?: OutputChannel): Promise<T>;

  /**
   * Free-text prompt. Returns `null` if cancelled (Ctrl+C).
   */
  textPrompt(message: string): Promise<string | null>;

  /**
   * Masked password prompt. Returns `null` if cancelled (Ctrl+C).
   */
  passwordPrompt(message: string): Promise<string | null>;

  /**
   * Yes/No prompt. Returns `null` if cancelled (Ctrl+C).
   */
  confirmPrompt(message: string, defaultValue: boolean): Promise<boolean | null>;

  /**
   * Single-select prompt. Returns `null` if cancelled (Ctrl+C).
   */
  selectPrompt<T>(message: string, options: SelectOption<T>[]): Promise<T | null>;

  /**
   * Multi-select prompt. Returns the selected values or `null` if cancelled.
   */
  multiSelectPrompt<T>(
    message: string,
    options: MultiSelectOption<T>[],
    loadMoreOpts?: MultiSelectPromptOptions<T>,
  ): Promise<T[] | null>;

  /**
   * Repeat {@link textPrompt} until `isValid` passes. Prints `errorMessage` after each
   * invalid attempt. Returns `null` if cancelled.
   */
  promptUntilValid(
    message: string,
    isValid: (value: string) => boolean,
    errorMessage: string,
  ): Promise<string | null>;

  /**
   * Press-Enter-to-continue. Skipped in CI or when stdin is not a TTY.
   */
  pressEnterKeyPrompt(message: string): Promise<void>;

  /**
   * When active, stdout messages (`info`, `success`, `discreetSuccess`, `text`) are
   * collected instead of printed, for JSON/TOON command output. Disabling clears
   * the buffer. stderr (`warn`, `error`) is never affected.
   */
  setFormattedOutputMode(active: boolean): void;

  /** True when stdout messages are buffered for machine-readable command output. */
  isFormattedOutputMode(): boolean;

  /** Messages collected since the last `setFormattedOutputMode(true)` call. */
  getMessagesForFormattedOutput(): string[];
}

export type {
  MultiSelectOption,
  MultiSelectPromptOptions,
  SelectOption,
} from './components/prompts.ts';
