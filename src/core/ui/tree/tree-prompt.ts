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

// Binds the tree view model and view to a clack prompt: keys become commands, changes redraw.

import { styleText } from 'node:util';

import { getColumns, Prompt } from '@clack/core';

import { isTTY } from '../colors.ts';
import type { TreePromptOptions } from './tree-source.ts';
import { renderCancelled, renderSubmitted, renderTreeView } from './tree-view.ts';
import type { TreeChoice } from './tree-view-model.ts';
import { TreeViewModel } from './tree-view-model.ts';

const BODY_HEIGHT = 13;
const FALLBACK_COLUMNS = 80;

function terminalColumns(): number {
  return (isTTY ? getColumns(process.stdout) : FALLBACK_COLUMNS) || FALLBACK_COLUMNS;
}

/**
 * Builds a single-select tree prompt; the caller runs it. `onFailure` receives a rejected
 * `loadChildren` or `search` and must make the prompt stop (by aborting `signal`), since a tree
 * that cannot expand is of no use.
 */
export function createTreePrompt<T>(
  message: string,
  opts: TreePromptOptions<T>,
  signal: AbortSignal,
  onFailure: (error: unknown) => void,
): Prompt<T> {
  return buildTreePrompt(
    message,
    opts,
    { signal, onFailure, multiple: false },
    (values) => values[0],
  );
}

/** Like {@link createTreePrompt}, but Tab ticks items and Enter submits every ticked value. */
export function createTreeMultiSelectPrompt<T>(
  message: string,
  opts: TreePromptOptions<T>,
  signal: AbortSignal,
  onFailure: (error: unknown) => void,
): Prompt<T[]> {
  return buildTreePrompt(message, opts, { signal, onFailure, multiple: true }, (values) => values);
}

interface PromptWiring {
  signal: AbortSignal;
  onFailure: (error: unknown) => void;
  multiple: boolean;
}

function buildTreePrompt<T, R>(
  message: string,
  opts: TreePromptOptions<T>,
  { signal, onFailure, multiple }: PromptWiring,
  result: (submitted: T[]) => R,
): Prompt<R> {
  const viewModel = new TreeViewModel(opts, { multiple, onError: onFailure });
  const searchable = opts.search !== undefined;
  const describe = (choice: TreeChoice<T>): string => opts.describe?.(choice.value) ?? choice.label;
  let blockSubmit = false;

  class TreePrompt extends Prompt<R> {
    protected override _shouldSubmit(): boolean {
      return !blockSubmit;
    }

    /** Tab ticks rather than types, so clack erases it from the query. */
    protected override _isActionKey(char: string | undefined): boolean {
      return char === '\t';
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

  const prompt: TreePrompt = new TreePrompt(
    {
      signal,
      render() {
        if (this.state === 'submit') {
          return renderSubmitted(message, viewModel.snapshot().chosen.map(describe));
        }
        if (this.state === 'cancel') return renderCancelled(message);
        return renderTreeView(viewModel.snapshot(), {
          message,
          columns: terminalColumns(),
          bodyHeight: BODY_HEIGHT,
          input: searchable ? prompt.inputWithCursor : undefined,
          noun: opts.noun ?? 'results',
        });
      },
    },
    searchable,
  );

  viewModel.onChange(() => {
    prompt.refresh();
  });

  prompt.on('userInput', (value) => {
    viewModel.setQuery(value);
  });

  prompt.on('cursor', (action) => {
    if (action === 'up') viewModel.moveBy(-1);
    else if (action === 'down') viewModel.moveBy(1);
    else if (action === 'left') viewModel.collapse();
    else if (action === 'right') viewModel.expand();
  });

  prompt.on('key', (_char, key) => {
    if (key.name === 'tab') {
      viewModel.toggle();
      return;
    }
    if (key.name !== 'return') return;
    const outcome = viewModel.submit();
    blockSubmit = !('submitted' in outcome);
    if ('submitted' in outcome) prompt.value = result(outcome.submitted);
  });

  const stop = (): void => {
    viewModel.dispose();
  };
  prompt.on('submit', stop);
  prompt.on('cancel', stop);

  return prompt;
}
