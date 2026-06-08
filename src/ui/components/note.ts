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

// Boxed note component with optional title

import { getColumns } from '@clack/core';

import { bold, dim, isTTY } from '../colors.js';
import { isMockActive, recordCall } from '../mock.js';
import type { ColorFn, NoteOptions } from '../types.js';

const MIN_WIDTH = 40;
const MAX_WIDTH = 80;
const TITLE_BORDER_PREFIX = '┌─ ';

function getWidth(): number {
  const cols = isTTY ? getColumns(process.stdout) : MIN_WIDTH;
  return Math.min(Math.max(cols - 4, MIN_WIDTH), MAX_WIDTH);
}

/**
 * Hard-split a word longer than `max` into chunks. Full-width chunks are pushed
 * to `out`; the trailing remainder (if any) is returned to seed the next line.
 */
function splitLongWord(word: string, max: number, out: string[]): string {
  let remainder = '';
  for (let i = 0; i < word.length; i += max) {
    const chunk = word.slice(i, i + max);
    if (chunk.length === max) out.push(chunk);
    else remainder = chunk;
  }
  return remainder;
}

/**
 * Word-wrap a single line to at most `max` characters, breaking on spaces.
 * A word longer than `max` is hard-split so nothing is lost. Returns at least
 * one line (possibly empty) so blank lines are preserved.
 */
function wrapLine(line: string, max: number): string[] {
  if (line.length <= max) return [line];

  const out: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (word.length > max) {
      if (current) out.push(current);
      current = splitLongWord(word, max, out);
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > max) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  out.push(current);
  return out;
}

function renderTTY(lines: string[], title: string | undefined, opts: NoteOptions): string {
  const borderColor: ColorFn = opts.borderColor ?? dim;
  const titleColor: ColorFn = opts.titleColor ?? bold;
  const contentColor: ColorFn = opts.contentColor ?? ((s) => s);

  const width = getWidth();
  const innerWidth = width - 2; // subtract border chars

  const top = title
    ? borderColor(TITLE_BORDER_PREFIX) +
      titleColor(title) +
      borderColor(' ' + '─'.repeat(Math.max(0, innerWidth - title.length - 1)) + '┐')
    : borderColor('┌' + '─'.repeat(width) + '┐');

  const empty = borderColor('│') + ' '.repeat(width) + borderColor('│');
  const bottom = borderColor('└' + '─'.repeat(width) + '┘');

  // Wrap each input line to the inner width so long content flows onto multiple
  // lines instead of being truncated.
  const wrapped = lines.flatMap((line) => wrapLine(line, width - 1));
  const contentLines = wrapped.map((line) => {
    const padded = line + ' '.repeat(Math.max(0, width - 1 - line.length));
    return borderColor('│') + ' ' + contentColor(padded) + borderColor('│');
  });

  return [top, empty, ...contentLines, empty, bottom].join('\n');
}

function renderPlain(lines: string[], title: string | undefined): string {
  const header = title ? `[${title}]` : '';
  return [header, ...lines].filter(Boolean).join('\n');
}

export function note(content: string | string[], title?: string, opts: NoteOptions = {}): void {
  if (isMockActive()) {
    recordCall('note', content, title);
    return;
  }

  const lines = Array.isArray(content) ? content : content.split('\n');
  const output = isTTY ? renderTTY(lines, title, opts) : renderPlain(lines, title);
  process.stdout.write(output + '\n');
}
