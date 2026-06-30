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

// Inline terminal output — non-interactive, static messages

import { cyan, green, isTTY, red, yellow } from './colors.js';
import { isMockActive, recordCall } from './mock.js';
import type { ColorFn, OutputChannel } from './types.js';

let _formattedOutputMode = false;
const _collectedMessages: string[] = [];

/**
 * Enable/disable formatted output mode (e.g. JSON output).
 * When active, stdout messages are collected into a buffer instead of printed.
 * Disabling clears the buffer.
 * stderr output (warn, error) is never affected.
 */
export function setFormattedOutputMode(active: boolean): void {
  _formattedOutputMode = active;
  if (!active) {
    _collectedMessages.length = 0;
  }
}

/** Returns messages collected since the last setFormattedOutputMode(true) call. */
export function getMessagesForFormattedOutput(): string[] {
  return [..._collectedMessages];
}

function write(stream: NodeJS.WriteStream, line: string): void {
  stream.write(line + '\n');
}

export function channelStream(channel: OutputChannel): NodeJS.WriteStream {
  return channel === 'stderr' ? process.stderr : process.stdout;
}

export function info(message: string): void {
  if (isMockActive()) {
    recordCall('info', message);
    return;
  }
  if (_formattedOutputMode) {
    _collectedMessages.push(`  ℹ  ${message}`);
    return;
  }
  write(process.stdout, `  ${cyan('ℹ')}  ${message}`);
}

export function success(message: string): void {
  if (isMockActive()) {
    recordCall('success', message);
    return;
  }
  if (_formattedOutputMode) {
    _collectedMessages.push(`✅ ${message}`);
    return;
  }
  write(process.stdout, `✅ ${green(message)}`);
}

export function discreetSuccess(message: string, channel: OutputChannel = 'stdout'): void {
  if (isMockActive()) {
    recordCall('discreetSuccess', message);
    return;
  }
  // Only stdout participates in formatted-output buffering; an explicit stderr
  // channel writes through immediately since stderr does not carry the payload.
  if (channel === 'stdout' && _formattedOutputMode) {
    _collectedMessages.push(`  ✓  ${message}`);
    return;
  }
  write(channelStream(channel), `  ${green('✓')}  ${message}`);
}

export function warn(message: string): void {
  if (isMockActive()) {
    recordCall('warn', message);
    return;
  }
  write(process.stderr, `⚠️ ${yellow(message)}`);
}

export function error(message: string): void {
  if (isMockActive()) {
    recordCall('error', message);
    return;
  }
  write(process.stderr, `❌ ${red(message)}`);
}

// Plain terminal output — human-readable, no semantic icon, optional color
export function text(message: string, color?: ColorFn, channel: OutputChannel = 'stdout'): void {
  if (isMockActive()) {
    recordCall('text', message);
    return;
  }
  // Only stdout participates in formatted-output buffering; an explicit stderr
  // channel writes through immediately since stderr does not carry the payload.
  if (channel === 'stdout' && _formattedOutputMode) {
    _collectedMessages.push(message);
    return;
  }
  const formatted = color ? color(message) : message;
  write(channelStream(channel), formatted);
}

// Raw stream output — no color, no prefix — safe for piping: sonar issues search | jq
export function print(message: string, channel: OutputChannel = 'stdout'): void {
  if (isMockActive()) {
    recordCall('print', message);
    return;
  }
  channelStream(channel).write(message + (message.endsWith('\n') ? '' : '\n'));
}

// Newline separator
export function blank(): void {
  if (isMockActive()) {
    recordCall('blank');
    return;
  }
  if (_formattedOutputMode) return;
  if (isTTY) process.stdout.write('\n');
}

/**
 * Greedy word wrap: packs whitespace-separated words into lines no longer than
 * `width`. A single word longer than `width` is left on its own over-long line
 * rather than split mid-word.
 */
export function wrapText(content: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of content.split(/\s+/)) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') {
    lines.push(current);
  }
  return lines;
}
