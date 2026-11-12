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

import { styleText } from 'node:util';

import { getColumns, Prompt } from '@clack/core';

import { bold, type ColorFn, cyan, dim, green, isTTY, red, yellow } from './colors.ts';
import type { SearchOption, SearchPromptOptions } from './console.ts';

const DEBOUNCE_MS = 150;
const ROW_INDENT = 6;
const LABEL_MAX_SHARE = 0.5;
const COLUMN_GAP = 2;
const FALLBACK_COLUMNS = 80;

/** Cuts `text` to `width` visible characters, ending in `…` when it had to cut. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…';
}

/** Paints every case-insensitive occurrence of `query` in `text` with `mark`, the rest with `base`. */
export function highlightMatches(
  text: string,
  query: string,
  base: ColorFn,
  mark: ColorFn,
): string {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return base(text);
  const haystack = text.toLowerCase();
  let out = '';
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    out += base(text.slice(from, at)) + mark(text.slice(at, at + needle.length));
    from = at + needle.length;
  }
  return out + base(text.slice(from));
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** How far a search for `query` has got, as the status line under its results reports it. */
export interface SearchProgress {
  query: string;
  /** Results on screen. */
  shown: number;
  /** Matches on the backing store, which may exceed `shown`. */
  total: number;
  /** A request is pending or in flight, so the list on screen may be stale. */
  loading: boolean;
  /** At least one search has completed for the current query. */
  loaded: boolean;
}

interface SearchState<T> {
  query: string;
  options: SearchOption<T>[];
  total: number;
  cursor: number;
  loading: boolean;
  loaded: boolean;
}

function renderRows<T>(state: SearchState<T>): string[] {
  const cols = (isTTY ? getColumns(process.stdout) : FALLBACK_COLUMNS) || FALLBACK_COLUMNS;
  const available = Math.max(10, cols - ROW_INDENT);
  const widest = Math.max(...state.options.map((o) => o.label.length), 0);
  const hasDetail = state.options.some((o) => o.detail);
  const labelWidth = hasDetail
    ? Math.min(widest, Math.floor(available * LABEL_MAX_SHARE))
    : Math.min(widest, available);
  const detailWidth = Math.max(0, available - labelWidth - COLUMN_GAP);

  return state.options.map((option, i) => {
    const selected = i === state.cursor;
    const label = truncate(option.label, labelWidth);
    const padding = ' '.repeat(Math.max(0, labelWidth - label.length));
    const base: ColorFn = selected ? bold : dim;
    const mark: ColorFn = (s) => (selected ? bold(yellow(s)) : yellow(s));
    const detail = option.detail
      ? highlightMatches(truncate(option.detail, detailWidth), state.query, dim, (s) => yellow(s))
      : '';
    const labelText = highlightMatches(label, state.query, selected ? (s) => s : base, mark);
    return `    ${selected ? cyan('›') : ' '} ${labelText}${padding}${detail ? ' '.repeat(COLUMN_GAP) + detail : ''}`;
  });
}

/** The status line under a result list: progress, the match count, or why nothing shows. */
export function renderFooter(
  progress: SearchProgress,
  noun: string,
  minQueryLength: number,
): string | undefined {
  const query = progress.query.trim();
  const needsMore = query.length > 0 && query.length < minQueryLength;
  if (needsMore) {
    return dim(`Type at least ${minQueryLength} characters to search.`);
  }
  if (progress.loading) {
    return dim('Searching…');
  }
  if (!progress.loaded) {
    return undefined;
  }
  if (progress.shown === 0) {
    return dim(query ? `No ${noun} match '${query}'.` : `No ${noun} found.`);
  }
  let what = noun;
  if (query) {
    what = progress.total === 1 ? 'match' : 'matches';
  }
  return progress.total > progress.shown
    ? dim(
        `Showing ${progress.shown} of ${formatCount(progress.total)} ${what}. Type more to narrow.`,
      )
    : dim(`${formatCount(progress.total)} ${what}`);
}

/**
 * Builds the prompt; the caller runs it. `onFailure` receives a rejected search and must make the
 * prompt stop (by aborting `signal`), since a picker whose list cannot load is of no use.
 */
export function createSearchPrompt<T>(
  message: string,
  opts: SearchPromptOptions<T>,
  signal: AbortSignal,
  onFailure: (error: unknown) => void,
): Prompt<T> {
  const noun = opts.noun ?? 'results';
  const minQueryLength = opts.minQueryLength ?? 1;
  const state: SearchState<T> = {
    query: '',
    options: [],
    total: 0,
    cursor: 0,
    loading: true,
    loaded: false,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Bumped per request and on finish, so a response that lost the race is dropped.
  let generation = 0;
  let blockSubmit = false;

  class SearchPrompt extends Prompt<T> {
    protected override _shouldSubmit(): boolean {
      return !blockSubmit;
    }

    get inputWithCursor(): string {
      const text = this.userInput;
      if (this._cursor >= text.length) return `${text}█`;
      const at = text.slice(this._cursor, this._cursor + 1);
      return text.slice(0, this._cursor) + styleText('inverse', at) + text.slice(this._cursor + 1);
    }

    /** Redraw via the base class's resize handler; `render` is private on Prompt. */
    refresh(): void {
      this.output.emit('resize');
    }
  }

  const prompt: SearchPrompt = new SearchPrompt({
    signal,
    render() {
      if (this.state === 'submit') {
        const chosen = state.options.find((o) => o.value === this.value);
        return `  ${green('✓')}  ${message} ${dim(chosen?.label ?? '')}`;
      }
      if (this.state === 'cancel') return `  ${red('✗')}  ${message}`;

      const hint = opts.hint ? ` ${dim('(' + opts.hint + ')')}` : '';
      const lines = [`  ${cyan('?')}  ${message}${hint}  ${prompt.inputWithCursor}`];
      lines.push(...renderRows(state));
      const footer = renderFooter({ ...state, shown: state.options.length }, noun, minQueryLength);
      if (footer) lines.push(`  ${footer}`);
      lines.push(`  ${dim('↑↓ move   Enter choose   Esc cancel')}`);
      return lines.join('\n');
    },
  });

  function runSearch(rawQuery: string, delayMs: number): void {
    clearTimeout(timer);
    const id = ++generation;
    const query = rawQuery.trim();
    if (query.length > 0 && query.length < minQueryLength) {
      state.loading = false;
      state.options = [];
      state.total = 0;
      prompt.refresh();
      return;
    }
    state.loading = true;
    timer = setTimeout(() => {
      opts.search(query).then(
        (results) => {
          if (id !== generation) return;
          state.options = results.options;
          state.total = results.total;
          state.cursor = 0;
          state.loading = false;
          state.loaded = true;
          prompt.refresh();
        },
        (error: unknown) => {
          if (id !== generation) return;
          state.loading = false;
          onFailure(error);
        },
      );
    }, delayMs);
    prompt.refresh();
  }

  prompt.on('userInput', (value) => {
    if (value === state.query) return;
    state.query = value;
    runSearch(value, DEBOUNCE_MS);
  });

  prompt.on('cursor', (action) => {
    const last = state.options.length - 1;
    if (action === 'up') state.cursor = Math.max(0, state.cursor - 1);
    else if (action === 'down') state.cursor = Math.max(0, Math.min(last, state.cursor + 1));
  });

  prompt.on('key', (_char, key) => {
    if (key.name !== 'return') return;
    const choice = state.options.at(state.cursor);
    // Enter on a list that is about to be replaced would pick something the user no longer sees.
    blockSubmit = state.loading || choice === undefined;
    if (choice !== undefined && !blockSubmit) prompt.value = choice.value;
  });

  const stop = (): void => {
    generation++;
    clearTimeout(timer);
  };
  prompt.on('submit', stop);
  prompt.on('cancel', stop);

  // Runs once the prompt is on screen; the user may already have typed, so use the current query.
  setTimeout(() => {
    runSearch(state.query, 0);
  }, 0);

  return prompt;
}
