// Boxed note component with optional title

import { getColumns } from '@clack/core';
import { isTTY, bold, dim } from '../colors.js';
import { isMockActive, recordCall } from '../mock.js';
import type { NoteOptions, ColorFn } from '../types.js';

const MIN_WIDTH = 40;
const MAX_WIDTH = 80;
const TITLE_BORDER_PREFIX = '┌─ ';
const TITLE_PADDING = TITLE_BORDER_PREFIX.length; // '┌─ ' = 3 chars

function getWidth(): number {
  const cols = isTTY ? getColumns(process.stdout) : MIN_WIDTH;
  return Math.min(Math.max(cols - 4, MIN_WIDTH), MAX_WIDTH);
}

function renderTTY(lines: string[], title: string | undefined, opts: NoteOptions): string {
  const borderColor: ColorFn = opts.borderColor ?? dim;
  const titleColor: ColorFn  = opts.titleColor  ?? bold;
  const contentColor: ColorFn = opts.contentColor ?? ((s) => s);

  const width = getWidth();
  const innerWidth = width - 2; // subtract border chars

  const top = title
    ? borderColor(TITLE_BORDER_PREFIX) + titleColor(title) + borderColor(' ' + '─'.repeat(Math.max(0, innerWidth - title.length - 1)) + '┐')
    : borderColor('┌' + '─'.repeat(width) + '┐');

  const empty = borderColor('│') + ' '.repeat(width) + borderColor('│');
  const bottom = borderColor('└' + '─'.repeat(width) + '┘');

  const contentLines = lines.map((line) => {
    const truncated = line.length > width - 1 ? line.slice(0, width - 4) + '...' : line;
    const padded = truncated + ' '.repeat(Math.max(0, width - 1 - truncated.length));
    return borderColor('│') + ' ' + contentColor(padded) + borderColor('│');
  });

  return [top, empty, ...contentLines, empty, bottom].join('\n');
}

function renderPlain(lines: string[], title: string | undefined): string {
  const header = title ? `[${title}]` : '';
  return [header, ...lines].filter(Boolean).join('\n');
}

export function note(content: string | string[], title?: string, opts: NoteOptions = {}): void {
  if (isMockActive()) { recordCall('note', content, title); return; }

  const lines = Array.isArray(content) ? content : content.split('\n');
  const output = isTTY ? renderTTY(lines, title, opts) : renderPlain(lines, title);
  process.stdout.write(output + '\n');
}
