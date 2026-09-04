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

import {
  ConfirmPrompt,
  isCancel,
  PasswordPrompt,
  Prompt,
  SelectPrompt,
  TextPrompt,
} from '@clack/core';

import { cyan, dim, green, red } from '../colors.ts';
import type { Console } from '../console.ts';

const CTRL_C = 0x03;
const ENTER_CR = 0x0d;
const ENTER_LF = 0x0a;
const EXIT_CODE_SIGINT = 130;

/**
 * Text input prompt. Returns null if cancelled (Ctrl+C).
 */
export async function renderTextPrompt(message: string): Promise<string | null> {
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
 * Password input prompt — masks input with bullet characters. Returns null if cancelled (Ctrl+C).
 */
export async function renderPasswordPrompt(message: string): Promise<string | null> {
  const prompt = new PasswordPrompt({
    render() {
      if (this.state === 'submit') return `  ${green('✓')}  ${message}`;
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
export async function renderConfirmPrompt(
  message: string,
  defaultValue: boolean,
): Promise<boolean | null> {
  const prompt = new ConfirmPrompt({
    active: 'Yes',
    inactive: 'No',
    initialValue: defaultValue,
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
export async function renderSelectPrompt<T>(
  message: string,
  options: SelectOption<T>[],
): Promise<T | null> {
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
  /** Shown but not toggleable (e.g. a repo that's already imported) — rendered like an at-cap row. */
  disabled?: boolean;
}

export interface MultiSelectPromptOptions<T> {
  /** True while more options can be revealed (e.g. a paginated collection's `hasMore`). */
  hasMore?: () => boolean;
  /**
   * Reveal more options, returning (or resolving to) the full updated list (existing options
   * plus newly revealed ones). May return a `Promise` when revealing more requires a network
   * call (e.g. `RepositoryCollection.loadMore`) — the "Load more" row shows a loading indicator
   * while it's in flight.
   */
  onLoadMore?: () => MultiSelectOption<T>[] | Promise<MultiSelectOption<T>[]>;
  /** Max number of selections. Defaults to 20; pass `Infinity` for no cap. */
  maxSelected?: number;
  /**
   * True total option count, for the "N/total selected" counter. Defaults to the currently
   * revealed `options.length`, which undercounts while paginated options remain unrevealed —
   * pass this when the caller's backing collection knows the real total up front (e.g.
   * `RepositoryCollection.length`).
   */
  total?: () => number;
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

/** Selection hint line shown while the multi-select prompt is active (not submitted/cancelled). */
function buildSelectHint(countLabel: string, atCap: boolean): string {
  if (atCap) {
    return dim(`(${countLabel} - at max, deselect to choose others)`);
  }
  return dim(`(${countLabel} - space to toggle, enter to confirm, q to quit)`);
}

function renderLoadMoreRow(isCursor: boolean, loading: boolean, error: string | null): string {
  if (loading) {
    return `    ${dim('…')}    ${dim('Loading...')}`;
  }
  const arrow = isCursor ? cyan('❯') : ' ';
  let label = 'Load more...';
  if (error) {
    const retryHint = dim(`(${error} - press enter to retry)`);
    label = `Load more... ${retryHint}`;
  }
  return `    ${arrow}    ${isCursor ? label : dim(label)}`;
}

function renderOptionRow(
  label: string,
  isCursor: boolean,
  isSelected: boolean,
  atCap: boolean,
  disabled: boolean,
): string {
  const unavailable = disabled || (atCap && !isSelected);
  const checkbox = checkboxComponent(isSelected, unavailable);
  const arrow = isCursor ? cyan('❯') : ' ';
  const displayLabel = isCursor && !unavailable ? label : dim(label);
  return `    ${arrow} ${checkbox}  ${displayLabel}`;
}

/**
 * Multi-select prompt. Space to toggle, Enter to confirm. Max 20 selections by default
 * (override via `loadMoreOpts.maxSelected`). Options with `disabled: true` are shown (dimmed,
 * like an at-cap row) but the cursor can't toggle them.
 * Returns the selected values array (may be empty) or null if cancelled (Ctrl+C or q).
 * Renders a scrolling viewport when the option list exceeds MULTISELECT_VIEWPORT_SIZE.
 *
 * When `loadMoreOpts` is given, a non-toggleable "Load more..." row is appended while
 * `hasMore()` is true; pressing Enter on that row calls `onLoadMore()` instead of submitting.
 * Selections are preserved across a load-more because they're tracked by value identity
 * (`===`) rather than by index — callers must return `===`-stable values for options that
 * were already present before the reload. When `onLoadMore` returns a `Promise`, the row shows
 * a loading indicator until it resolves; Enter is ignored on every other row while it's pending.
 */
export async function renderMultiSelectPrompt<T>(
  message: string,
  initialOptions: MultiSelectOption<T>[],
  loadMoreOpts?: MultiSelectPromptOptions<T>,
): Promise<T[] | null> {
  let options = initialOptions;
  const selected: T[] = [];
  let cursor = 0;
  let loadingMore = false;
  let loadMoreError: string | null = null;
  const maxSelected = loadMoreOpts?.maxSelected ?? MULTISELECT_MAX_SELECTED;

  const onLoadMore = loadMoreOpts?.onLoadMore;
  const hasMore = (): boolean => onLoadMore !== undefined && (loadMoreOpts?.hasMore?.() ?? false);
  const isOnLoadMoreRow = (): boolean => hasMore() && cursor === options.length;
  const getTotal = (): number => loadMoreOpts?.total?.() ?? options.length;

  // Calling `onLoadMore()` can reveal the last page, flipping `hasMore()` to false — so
  // `isOnLoadMoreRow()` must be frozen BEFORE calling it. `_shouldSubmit` runs right after our
  // 'key' handler within the same keypress, so recomputing live here would otherwise let the
  // very keypress that triggered the load also submit the prompt in the same tick.
  let pendingLoadMoreSubmitBlock = false;

  class MultiSelectLoadMorePrompt extends Prompt<T[]> {
    protected override _shouldSubmit(): boolean {
      return !pendingLoadMoreSubmitBlock;
    }

    /**
     * Forces a redraw outside of a keypress (needed once an async `onLoadMore()` resolves).
     * `render` is private on the base class, but `output` is protected and the base
     * constructor already wires `output.on('resize', this.render)` for terminal resizes —
     * reusing that plumbing to trigger a render is simpler than re-implementing it.
     */
    refresh(): void {
      this.output.emit('resize');
    }
  }

  const prompt = new MultiSelectLoadMorePrompt(
    {
      render() {
        if (this.state === 'submit') {
          const selectedLabel = `${selected.length} of ${getTotal()} selected`;
          return `  ${green('✓')}  ${message} ${dim(selectedLabel)}`;
        }
        if (this.state === 'cancel') {
          return `  ${red('✗')}  ${message}`;
        }

        const atCap = selected.length >= maxSelected;
        const countLabel = `${selected.length}/${getTotal()} selected`;
        const hint = buildSelectHint(countLabel, atCap);

        const loadMoreRowVisible = hasMore() || loadingMore;
        const total = options.length + (loadMoreRowVisible ? 1 : 0);
        const { start, end } = calculateViewport(cursor, total, MULTISELECT_VIEWPORT_SIZE);

        const lines = [`  ${cyan('?')}  ${message}  ${hint}`];

        if (start > 0) {
          const more = `↑ ${start} more`;
          lines.push(`      ${dim(more)}`);
        }

        for (let i = start; i < end; i++) {
          const isCursor = i === cursor;

          if (loadMoreRowVisible && i === options.length) {
            lines.push(renderLoadMoreRow(isCursor, loadingMore, loadMoreError));
            continue;
          }

          const opt = options[i];
          const isSelected = selected.includes(opt.value);
          lines.push(
            renderOptionRow(opt.label, isCursor, isSelected, atCap, opt.disabled ?? false),
          );
        }

        const more = `↓ ${total - end} more`;
        if (end < total) lines.push(`      ${dim(more)}`);

        return lines.join('\n');
      },
    },
    false,
  );

  prompt.on('cursor', (dir) => {
    const total = options.length + (hasMore() ? 1 : 0);
    if (dir === 'up') cursor = Math.max(0, cursor - 1);
    else if (dir === 'down') cursor = Math.min(total - 1, cursor + 1);
    else if (dir === 'space') {
      const val = options[cursor]?.value;
      if (val !== undefined && !options[cursor]?.disabled) {
        toggleSelected(selected, val, maxSelected);
      }
    }
  });

  prompt.on('key', (_key, s) => {
    if (s.name === 'return') {
      if (loadingMore) {
        // A load is already in flight — ignore Enter entirely rather than letting it submit
        // (or start a second overlapping load) while `options` is about to be replaced.
        pendingLoadMoreSubmitBlock = true;
        return;
      }
      if (isOnLoadMoreRow() && onLoadMore) {
        pendingLoadMoreSubmitBlock = true;
        loadingMore = true;
        loadMoreError = null;
        void Promise.resolve(onLoadMore())
          .then((loaded) => {
            options = loaded;
          })
          .catch((err: unknown) => {
            // Leave `options`/`hasMore()` untouched so the row reappears and Enter retries.
            loadMoreError = err instanceof Error ? err.message : String(err);
          })
          .finally(() => {
            loadingMore = false;
            prompt.refresh();
          });
        return;
      }
      pendingLoadMoreSubmitBlock = false;
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
export async function renderPromptUntilValid(
  message: string,
  isValid: (value: string) => boolean,
  errorMessage: string,
  console: Console,
): Promise<string | null> {
  for (;;) {
    const value = await console.textPrompt(message);
    if (value === null) {
      return null;
    }
    if (isValid(value)) {
      return value;
    }
    console.print(errorMessage);
  }
}

/**
 * Press-Enter-to-continue prompt using raw stdin.
 * Only Enter advances the prompt; all other keys are silently consumed.
 * Skipped automatically in CI=true or non-TTY environments.
 */
export async function renderPressEnterKeyPrompt(message: string): Promise<void> {
  if (process.env.CI === 'true') {
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
