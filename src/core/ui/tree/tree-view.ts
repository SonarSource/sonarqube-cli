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

// The tree prompt's view: turns a snapshot into the text on screen, keeping no state.

import { bold, type ColorFn, cyan, dim, green, red, yellow } from '../colors.ts';
import { highlightMatches, renderFooter, truncate } from '../search-prompt.ts';
import { calculateViewport } from '../viewport.ts';
import type { TreeEntry, TreeMarker, TreeSnapshot } from './tree-view-model.ts';

const ROW_INDENT = 8;
const LEVEL_INDENT = '  ';
const DETAIL_GAP = '  ';
const CHECKBOX_WIDTH = 2;
const MARKER_WIDTH = 2;
const MIN_LABEL_WIDTH = 10;

const MARKERS: Record<TreeMarker, string> = {
  expanded: '▾',
  collapsed: '▸',
  leaf: ' ',
  loading: '…',
};

export interface TreeViewLayout {
  message: string;
  columns: number;
  /** Lines between the question and the key hints: the list plus any status lines under it. */
  bodyHeight: number;
  /** The query being typed, cursor included; absent when the tree cannot be searched. */
  input?: string;
  /** Plural noun for the search status line, e.g. `folders`. */
  noun: string;
}

function renderCheckbox(checked: boolean | undefined): string {
  if (checked === undefined) return '';
  return (checked ? green('◼') : dim('◻')) + ' ';
}

function renderEntry(entry: TreeEntry, isCursor: boolean, columns: number): string {
  const indent = LEVEL_INDENT.repeat(entry.depth);
  const lead = entry.marker === undefined ? '' : indent + dim(MARKERS[entry.marker]) + ' ';
  const leadWidth = entry.marker === undefined ? 0 : indent.length + MARKER_WIDTH;
  const checkboxWidth = entry.checked === undefined ? 0 : CHECKBOX_WIDTH;
  const available = Math.max(MIN_LABEL_WIDTH, columns - ROW_INDENT - leadWidth - checkboxWidth);
  const label = truncate(entry.label, available);
  const detailWidth = available - label.length - DETAIL_GAP.length;
  const detail =
    entry.detail && detailWidth > 0 ? DETAIL_GAP + green(truncate(entry.detail, detailWidth)) : '';
  const base: ColorFn = isCursor ? bold : dim;
  const mark: ColorFn = (s) => (isCursor ? bold(yellow(s)) : yellow(s));
  const text = highlightMatches(label, entry.highlight ?? '', base, mark);
  const pointer = isCursor ? cyan('›') : ' ';
  return `    ${pointer} ${lead}${renderCheckbox(entry.checked)}${text}${detail}`;
}

function renderMore(arrow: string, count: number): string {
  return '      ' + dim(`${arrow} ${count} more`);
}

/**
 * The rows around `cursor`, with counts of those scrolled off, padded with blank lines to `size`
 * so the prompt keeps its height whatever the list holds.
 */
export function renderWindow(
  count: number,
  cursor: number,
  line: (index: number) => string,
  size: number,
): string[] {
  const { start, end } = calculateViewport(cursor, count, size);
  const lines: string[] = [];
  if (start > 0) lines.push(renderMore('↑', start));
  for (let i = start; i < end; i++) lines.push(line(i));
  if (end < count) lines.push(renderMore('↓', count - end));
  while (lines.length < size) lines.push('');
  return lines;
}

function statusLines<T>(snapshot: TreeSnapshot<T>, noun: string): string[] {
  const lines: string[] = [];
  if (snapshot.search) {
    lines.push(renderFooter(snapshot.search, noun, 1) ?? '');
  }
  if (snapshot.multiple) {
    lines.push(
      snapshot.refused
        ? yellow('Select at least one with Tab.')
        : dim(String(snapshot.chosen.length) + ' selected'),
    );
  }
  return lines;
}

function keyHints<T>({ multiple, searching }: TreeSnapshot<T>): string {
  const navigation = searching ? '↑↓ move' : '↑↓ move   → expand   ← collapse';
  const choosing = multiple ? 'Tab select   Enter confirm' : 'Enter choose';
  return `${navigation}   ${choosing}   Esc cancel`;
}

export function renderTreeView<T>(snapshot: TreeSnapshot<T>, layout: TreeViewLayout): string {
  const input = layout.input === undefined ? '' : ` ${dim('(type to search)')}  ${layout.input}`;
  const status = statusLines(snapshot, layout.noun).map((line) => '  ' + line);
  // Status lines come out of the fixed body height; the list gets the rest.
  const list = renderWindow(
    snapshot.entries.length,
    snapshot.cursor,
    (i) => renderEntry(snapshot.entries[i], i === snapshot.cursor, layout.columns),
    layout.bodyHeight - status.length,
  );
  return [
    `  ${cyan('?')}  ${layout.message}${input}`,
    ...list,
    ...status,
    '  ' + dim(keyHints(snapshot)),
  ].join('\n');
}

export function renderSubmitted(message: string, chosen: readonly string[]): string {
  return `  ${green('✓')}  ${message} ${dim(chosen.join(', '))}`;
}

export function renderCancelled(message: string): string {
  return `  ${red('✗')}  ${message}`;
}
